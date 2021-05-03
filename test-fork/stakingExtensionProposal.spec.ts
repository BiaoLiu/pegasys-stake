import { expect } from 'chai';
import rawHRE from 'hardhat';
import { BigNumber } from 'ethers';
import { formatEther, parseEther } from 'ethers/lib/utils';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';
import { JsonRpcSigner } from '@ethersproject/providers';
import { DRE, increaseTimeAndMine, timeLatest, waitForTx } from '../helpers/misc-utils';
import {
  increaseTime,
  latestBlock,
  advanceBlockTo,
  impersonateAccountsHardhat,
} from '../helpers/misc-utils';
import { MAX_UINT_AMOUNT } from '../helpers/constants';
import { IAaveGovernanceV2 } from '../types/IAaveGovernanceV2';
import { ILendingPool } from '../types/ILendingPool';
import {
  AToken,
  StakedTokenV2Rev3,
  StakedAaveV2,
  StakedAaveV2__factory,
  Erc20,
  SelfdestructTransfer__factory,
  Erc20__factory,
  AToken__factory,
  IDelegationAwareToken__factory,
} from '../types';
import { spendList } from './helpers';
import { deployStakedTokenV2Revision3 } from '../helpers/contracts-accessors';
import { logError } from '../helpers/tenderly-utils';

const {
  RESERVES = 'DAI,GUSD,USDC,USDT,WBTC,WETH',
  POOL_CONFIGURATOR = '0x311bb771e4f8952e6da169b425e7e92d6ac45756',
  POOL_DATA_PROVIDER = '0x057835Ad21a177dbdd3090bB1CAE03EaCF78Fc6d',
  ECO_RESERVE = '0x25F2226B597E8F9514B3F68F00f494cF4f286491',
  AAVE_TOKEN = '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9',
  IPFS_HASH = 'QmT9qk3CRYbFDWpDFYeAv8T8H1gnongwKhh5J68NLkLir6', // WIP
  AAVE_GOVERNANCE_V2 = '0xEC568fffba86c094cf06b22134B23074DFE2252c', // mainnet
  AAVE_LONG_EXECUTOR = '0x61910ecd7e8e942136ce7fe7943f956cea1cc2f7', // mainnet
} = process.env;

if (
  !RESERVES ||
  !POOL_CONFIGURATOR ||
  !POOL_DATA_PROVIDER ||
  !ECO_RESERVE ||
  !AAVE_TOKEN ||
  !IPFS_HASH ||
  !AAVE_GOVERNANCE_V2 ||
  !AAVE_LONG_EXECUTOR
) {
  throw new Error('You have not set correctly the .env file, make sure to read the README.md');
}

const AAVE_LENDING_POOL = '0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9';
const VOTING_DURATION = 64000;

const AAVE_WHALE = '0x25f2226b597e8f9514b3f68f00f494cf4f286491';
const AAVE_WHALE_2 = '0xbe0eb53f46cd790cd13851d5eff43d12404d33e8';

const AAVE_STAKE = '0x4da27a545c0c5B758a6BA100e3a049001de870f5';
const DAI_TOKEN = '0x6b175474e89094c44da98b954eedeac495271d0f';
const DAI_HOLDER = '0x72aabd13090af25dbb804f84de6280c697ed1150';

describe('Proposal: Extend Staked Aave distribution', () => {
  let ethers;

  let whale: JsonRpcSigner;
  let daiHolder: JsonRpcSigner;
  let proposer: SignerWithAddress;
  let gov: IAaveGovernanceV2;
  let pool: ILendingPool;
  let aave: Erc20;
  let dai: Erc20;
  let aDAI: AToken;
  let proposalId: BigNumber;
  let stakedAaveV2Revision3Implementation: StakedTokenV2Rev3;
  let aaveStakeV2: StakedAaveV2;
  before(async () => {
    await rawHRE.run('set-dre');
    ethers = DRE.ethers;
    [proposer] = await DRE.ethers.getSigners();

    // Deploy STKAaveV2 Revision 3 implementation
    stakedAaveV2Revision3Implementation = await deployStakedTokenV2Revision3(
      [
        '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9',
        '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9',
        '864000',
        '172800',
        '0x25F2226B597E8F9514B3F68F00f494cF4f286491',
        '0xEE56e2B3D491590B5b31738cC34d5232F378a8D5',
        '3153600000',
        'Staked AAVE',
        'stkAAVE',
        '18',
        '0x0000000000000000000000000000000000000000',
      ],
      true
    );

    // Send ether to the AAVE_WHALE, which is a non payable contract via selfdestruct
    const selfDestructContract = await new SelfdestructTransfer__factory(proposer).deploy();
    await (
      await selfDestructContract.destroyAndTransfer(AAVE_WHALE, {
        value: ethers.utils.parseEther('1'),
      })
    ).wait();

    // Impersonating holders
    await impersonateAccountsHardhat([
      AAVE_WHALE,
      AAVE_WHALE_2,
      ...Object.keys(spendList).map((k) => spendList[k].holder),
    ]);

    const whale2 = ethers.provider.getSigner(AAVE_WHALE_2);
    whale = ethers.provider.getSigner(AAVE_WHALE);
    daiHolder = ethers.provider.getSigner(DAI_HOLDER);

    // Initialize contracts and tokens
    gov = (await ethers.getContractAt(
      'IAaveGovernanceV2',
      AAVE_GOVERNANCE_V2,
      proposer
    )) as IAaveGovernanceV2;
    pool = (await ethers.getContractAt(
      'ILendingPool',
      AAVE_LENDING_POOL,
      proposer
    )) as ILendingPool;

    const {
      configuration: { data },
      aTokenAddress,
      variableDebtTokenAddress,
    } = await pool.getReserveData(DAI_TOKEN);

    aave = Erc20__factory.connect(AAVE_TOKEN, whale);
    aaveStakeV2 = StakedAaveV2__factory.connect(AAVE_STAKE, proposer);
    dai = Erc20__factory.connect(DAI_TOKEN, daiHolder);
    aDAI = AToken__factory.connect(aTokenAddress, proposer);

    // Transfer enough AAVE to proposer
    await (await aave.transfer(proposer.address, parseEther('2000000'))).wait();
    // Transfer enough AAVE to proposer
    await (await aave.connect(whale2).transfer(proposer.address, parseEther('1200000'))).wait();

    // Transfer DAI to repay future DAI loan
    await (await dai.transfer(proposer.address, parseEther('100000'))).wait();
  });

  it('Proposal should be created', async () => {
    await advanceBlockTo((await latestBlock()) + 10);
    const aaveGovToken = IDelegationAwareToken__factory.connect(AAVE_TOKEN, proposer);

    try {
      const balance = await aave.balanceOf(proposer.address);
      console.log('AAVE Balance proposer', formatEther(balance));
      const propositionPower = await aaveGovToken.getPowerAtBlock(
        proposer.address,
        ((await latestBlock()) - 1).toString(),
        '1'
      );

      console.log(
        `Proposition power of ${proposer.address} at block - 1`,
        formatEther(propositionPower)
      );
    } catch (error) {
      console.log(error);
    }
    // Submit proposal
    proposalId = await gov.getProposalsCount();

    await DRE.run('propose-extension', {
      stkAaveProxy: AAVE_STAKE,
      stkAaveImpl: stakedAaveV2Revision3Implementation.address,
      aaveGovernance: AAVE_GOVERNANCE_V2,
      longExecutor: AAVE_LONG_EXECUTOR,
      ipfsHash: IPFS_HASH,
    });
    console.log('submited');

    // Mine block due flash loan voting protection
    await advanceBlockTo((await latestBlock()) + 1);

    const votingPower = await aaveGovToken.getPowerAtBlock(
      proposer.address,
      ((await latestBlock()) - 1).toString(),
      '0'
    );
    console.log(`Voting power of ${proposer.address} at block - 1`, formatEther(votingPower));

    // Submit vote and advance block to Queue phase
    await (await gov.submitVote(proposalId, true, { gasLimit: 300000 })).wait();
    await advanceBlockTo((await latestBlock()) + VOTING_DURATION + 1);
  });

  it('Proposal should be queued', async () => {
    const proposalState1 = await gov.getProposalState(proposalId);
    console.log('wat', proposalState1);

    // Queue and advance block to Execution phase
    try {
      await (await gov.queue(proposalId, { gasLimit: 3000000 })).wait();
      console.log('queued');
    } catch (error) {
      logError();
      throw error;
    }

    const proposalState = await gov.getProposalState(proposalId);
    expect(proposalState).to.be.equal(5);

    await increaseTime(604800 + 10);
  });

  it('Proposal should be executed', async () => {
    // Execute payload
    try {
      await (await gov.execute(proposalId, { gasLimit: 3000000 })).wait();
      console.log('executed');
    } catch (error) {
      logError();
      throw error;
    }

    console.log('Proposal executed');

    const proposalState = await gov.getProposalState(proposalId);
    expect(proposalState).to.be.equal(7);
  });

  it('Users should be able to stake AAVE', async () => {
    const amount = parseEther('1');
    await waitForTx(await aave.connect(proposer).approve(aaveStakeV2.address, amount));
    await expect(aaveStakeV2.stake(proposer.address, amount)).to.be.ok;
  });

  it('Users should be able to claim stkAave', async () => {
    const staker = proposer;

    await aaveStakeV2.cooldown();
    const startedCooldownAt = BigNumber.from(
      (await aaveStakeV2.stakersCooldowns(staker.address)).toString()
    );
    const COOLDOWN_SECONDS = await aaveStakeV2.COOLDOWN_SECONDS();
    const currentTime = await timeLatest();

    const remainingCooldown = startedCooldownAt.add(COOLDOWN_SECONDS).sub(currentTime.toString());

    await increaseTimeAndMine(remainingCooldown.add(1).toNumber());
    await expect(aaveStakeV2.redeem(staker.address, MAX_UINT_AMOUNT)).to.be.ok;
  });
  it('Staked Aave Distribution end should be extended', async () => {
    const implDistributionEnd = await stakedAaveV2Revision3Implementation.DISTRIBUTION_END();
    const proxyDistributionEnd = await aaveStakeV2.DISTRIBUTION_END();

    expect(implDistributionEnd).to.be.eq(proxyDistributionEnd, 'DISTRIBUTION_END SHOULD MATCH');
  });
  it('Staked Aave Distribution revision should be 3', async () => {
    const revisionImpl = await stakedAaveV2Revision3Implementation.REVISION();
    const revisionProxy = await aaveStakeV2.REVISION();

    expect(revisionImpl).to.be.eq(revisionProxy, 'DISTRIBUTION_END SHOULD MATCH');
  });
  it('Users should be able to deposit DAI at Lending Pool', async () => {
    // Deposit DAI to LendingPool
    await (await dai.connect(proposer).approve(pool.address, parseEther('2000'))).wait();

    const tx = await pool.deposit(dai.address, parseEther('100'), proposer.address, 0);
    expect(tx).to.emit(pool, 'Deposit');
  });

  it('Users should be able to request DAI loan from Lending Pool', async () => {
    // Request DAI loan to LendingPool
    const tx = await pool.borrow(dai.address, parseEther('1'), '2', '0', proposer.address);
    expect(tx).to.emit(pool, 'Borrow');
  });

  it('Users should be able to repay DAI loan from Lending Pool', async () => {
    // Repay DAI variable loan to LendingPool
    await (await dai.connect(proposer).approve(pool.address, MAX_UINT_AMOUNT)).wait();
    const tx = await pool.repay(dai.address, MAX_UINT_AMOUNT, '2', proposer.address);
    expect(tx).to.emit(pool, 'Repay');
  });

  it('Users should be able to withdraw DAI from Lending Pool', async () => {
    // Withdraw DAI from LendingPool
    await (await aDAI.connect(proposer).approve(pool.address, MAX_UINT_AMOUNT)).wait();
    const tx = await pool.withdraw(dai.address, MAX_UINT_AMOUNT, proposer.address);
    expect(tx).to.emit(pool, 'Withdraw');
  });
});
