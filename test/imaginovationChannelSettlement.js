/* 
    This test is testing channel creating via settlement. It also tests partial stake increase. 
    Tested functions can be found in smart-contract code at `contracts/ImaginovationImplementation.sol`. 
*/ 
 
const { BN } = require('web3-utils'); 
const { 
    generateChannelId, 
    topUpTokens, 
    topUpEthers, 
    setupDEX 
} = require('./utils/index.js') 
const wallet = require('./utils/wallet.js') 
const { 
    signIdentityRegistration, 
    signChannelBeneficiaryChange, 
    generatePromise 
} = require('./utils/client.js') 
const { 
    assertEvent 
} = require('./utils/tests.js') 
const { expect } = require('chai') 
 
const MystToken = artifacts.require("TestMystToken") 
const ImaginovationImplementation = artifacts.require("TestImaginovationImplementation") 
 
const ChannelImplementation = artifacts.require("ChannelImplementation") 
const Registry = artifacts.require("Registry") 
 
const OneToken = web3.utils.toWei(new BN('100000000'), 'wei') 
const OneEther = web3.utils.toWei(new BN(1), 'ether') 
const Zero = new BN(0) 
const ZeroAddress = '0x0000000000000000000000000000000000000000' 
const Five = new BN(5) 
const ChainID = 1 
const ImaginovationURL = Buffer.from('http://test.Imaginovation') 
 
const operator = wallet.generateAccount(Buffer.from('d6dd47ec61ae1e85224cec41885eec757aa77d518f8c26933e5d9f0cda92f3c3', 'hex'))  // Generate Imaginovation operator wallet 
const providerA = wallet.generateAccount() 
 
const minStake = new BN(0) 
const maxStake = new BN(50000) 
const ImaginovationStake = new BN(100000) 
 
contract("Channel openinig via settlement tests", ([txMaker, beneficiaryA, beneficiaryB, beneficiaryC, ...otherAccounts]) => { 
    let token, Imaginovation, registry 
    before(async () => { 
        token = await MystToken.new() 
        const dex = await setupDEX(token, txMaker) 
        const ImaginovationImplementation = await ImaginovationImplementation.new() 
        const channelImplementation = await ChannelImplementation.new() 
        registry = await Registry.new() 
        await registry.initialize(token.address, dex.address, ImaginovationStake, channelImplementation.address, ImaginovationImplementation.address, ZeroAddress) 
 
        // Give some ethers for gas for operator 
        await topUpEthers(txMaker, operator.address, OneEther) 
 
        // Give tokens for txMaker so it could use them registration 
        await topUpTokens(token, txMaker, OneToken) 
        await token.approve(registry.address, OneToken) 
    }) 
 
    it("should register and initialize Imaginovation hub", async () => { 
        await registry.registerImaginovation(operator.address, ImaginovationStake, Zero, minStake, maxStake, ImaginovationURL) 
        const ImaginovationId = await registry.getImaginovationAddress(operator.address) 
        expect(await registry.isImaginovation(ImaginovationId)).to.be.true 
 
        // Initialise Imaginovation object 
        Imaginovation = await ImaginovationImplementation.at(ImaginovationId) 
 
        // Topup some balance for Imaginovation 
        await topUpTokens(token, Imaginovation.address, OneToken) 
    }) 
 
    it("register consumer identity", async () => { 
        const regSignature = signIdentityRegistration(registry.address, Imaginovation.address, Zero, Zero, beneficiaryA, providerA) 
        await registry.registerIdentity(Imaginovation.address, Zero, Zero, beneficiaryA, regSignature) 
        expect(await registry.isRegistered(providerA.address)).to.be.true 
    }) 
 
    it("should open provider channel while settling promise", async () => { 
        const nonce = new BN(1) 
        const channelId = await Imaginovation.getChannelId(providerA.address) 
        const channelState = Object.assign({}, { channelId }, await Imaginovation.channels(channelId)) 
 
        const amountToPay = new BN('15') 
        const balanceBefore = await token.balanceOf(beneficiaryA) 
 
        // To open channel during settlement we must call `settleWithBeneficiary` instead of `settlePromise` 
        const beneficiaryChangeSignature = signChannelBeneficiaryChange(ChainID, registry.address, beneficiaryA, nonce, providerA) 
        const promise = generatePromise(amountToPay, Zero, channelState, operator, providerA.address) 
        var res = await Imaginovation.settleWithBeneficiary(promise.identity, promise.amount, promise.fee, promise.lock, promise.signature, beneficiaryA, beneficiaryChangeSignature) 
 
        assertEvent(res, 'PromiseSettled', { "lock": "0x" + promise.lock.toString('hex') }) 
 
        const balanceAfter = await token.balanceOf(beneficiaryA) 
        balanceAfter.should.be.bignumber.equal(balanceBefore.add(amountToPay)) 
 
        const channelBeneficiary = await registry.getBeneficiary(providerA.address) 
        expect(channelBeneficiary).to.be.equal(beneficiaryA) 
 
        expect(await Imaginovation.isChannelOpened(channelId)).to.be.true 
    }) 
 
    it("settling promises bigger than stake should be handled correctly", async () => { 
        const channelId = generateChannelId(providerA.address, Imaginovation.address) 
        const channel = await Imaginovation.channels(channelId) 
        const channelState = Object.assign({}, { channelId }, channel) 
        const initialChannelStake = channel.stake 
        const amountToPay = new BN('275') 
 
        const balanceBefore = await token.balanceOf(beneficiaryA) 
 
        // Generate and settle promise 
        const promise = generatePromise(amountToPay, Zero, channelState, operator, providerA.address) 
        var res = await Imaginovation.settlePromise(promise.identity, promise.amount, promise.fee, promise.lock, promise.signature) 
 
        assertEvent(res, 'PromiseSettled', { "lock": "0x" + promise.lock.toString('hex') }) 
 
        // Promise can settle even more than its stake (up to maxStake) 
        const balanceAfter = await token.balanceOf(beneficiaryA) 
        balanceAfter.should.be.bignumber.equal(balanceBefore.add(amountToPay)) 
 
        amountToPay.should.be.bignumber.greaterThan(initialChannelStake) 
    }) 
 
    it("should be possible use same huge promise multiple times untill whole amount is not settled", async () => { 
        const channelId = generateChannelId(providerA.address, Imaginovation.address) 
        const channel = await Imaginovation.channels(channelId) 
        const channelState = Object.assign({}, { channelId }, channel) 
 
        // Generate huge stake 
        const amountToPay = maxStake.mul(Five) 
        const promise = generatePromise(amountToPay, Zero, channelState, operator, providerA.address) 
 
        // It should be possible to use promise couple of times 
        for (let times = 0; times < 5; times++) { 
            const balanceBefore = await token.balanceOf(beneficiaryA) 
 
            let res = await Imaginovation.settlePromise(promise.identity, promise.amount, promise.fee, promise.lock, promise.signature) 
 
            assertEvent(res, 'PromiseSettled', { "lock": "0x" + promise.lock.toString('hex') }) 
 
            const balanceAfter = await token.balanceOf(beneficiaryA) 
            balanceAfter.should.be.bignumber.equal(balanceBefore.add(maxStake)) 
        } 
 
        // Promise settlement should fail when there is no unsettled tokens anymore 
        await Imaginovation.settlePromise(promise.identity, promise.amount, promise.fee, promise.lock, promise.signature).should.be.rejected 
    }) 
 
    it("should be possible to settle into stake", async () => { 
        const channelId = generateChannelId(providerA.address, Imaginovation.address) 
        const channel = await Imaginovation.channels(channelId) 
        const channelState = Object.assign({}, { channelId }, channel) 
        const amountToPay = new BN('50') 
        const transactorFee = new BN('5') 
        const transactorBalanceBefore = await token.balanceOf(txMaker) 
 
        // Generate promise and settle into stake 
        const promise = generatePromise(amountToPay, transactorFee, channelState, operator, providerA.address) 
        var res = await Imaginovation.settleIntoStake(promise.identity, promise.amount, promise.fee, promise.lock, promise.signature) 
 
        assertEvent(res, 'PromiseSettled', { "lock": "0x" + promise.lock.toString('hex') }) 
 
        // It should have increased stake 
        const channelStakeAfter = (await Imaginovation.channels(channelId)).stake 
        channelStakeAfter.should.be.bignumber.greaterThan(channel.stake)  // prove that stak was increased 
        channelStakeAfter.should.be.bignumber.equal(channel.stake.add(amountToPay)) 
 
        // Transactor should get it's fee 
        const transactorBalanceAfter = await token.balanceOf(txMaker) 
        transactorBalanceAfter.should.be.bignumber.equal(transactorBalanceBefore.add(transactorFee)) 
    }) 
}) 
