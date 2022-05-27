/* 
    This test is testing seting new beneficiary in provider channel. 
    Tested functions can be found in smart-contract code at `contracts/ImaginovationImplementation.sol`. 
*/ 
 
const { BN } = require('web3-utils') 
const { 
    generateChannelId, 
    topUpTokens, 
    topUpEthers, 
    setupDEX 
} = require('./utils/index.js') 
const wallet = require('./utils/wallet.js') 
const { 
    signChannelBeneficiaryChange, 
    signIdentityRegistration, 
    generatePromise 
} = require('./utils/client.js') 
const { identity } = require('lodash') 
 
const MystToken = artifacts.require("TestMystToken") 
const Registry = artifacts.require("Registry") 
const ImaginovationImplementation = artifacts.require("TestImaginovationImplementation") 
const ChannelImplementation = artifacts.require("ChannelImplementation") 
 
const ZeroAddress = '0x0000000000000000000000000000000000000000' 
const OneToken = web3.utils.toWei(new BN('1000000000000000000'), 'wei') 
const OneEther = web3.utils.toWei(new BN(1), 'ether') 
const Zero = new BN(0) 
const One = new BN(1) 
const ChainId = 1 
const ImaginovationURL = Buffer.from('http://test.Imaginovation') 
 
 
// const operatorPrivKey = Buffer.from('d6dd47ec61ae1e85224cec41885eec757aa77d518f8c26933e5d9f0cda92f3c3', 'hex') 
const operator = wallet.generateAccount(Buffer.from('d6dd47ec61ae1e85224cec41885eec757aa77d518f8c26933e5d9f0cda92f3c3', 'hex'))  // Generate Imaginovation operator wallet 
const provider = wallet.generateAccount() 
 
contract("Setting beneficiary tests", ([txMaker, operatorAddress, beneficiaryA, beneficiaryB, beneficiaryC, ...otherAccounts]) => { 
    let token, Imaginovation, registry, beneficiaryChangeSignature 
    before(async () => { 
        token = await MystToken.new() 
        const dex = await setupDEX(token, txMaker) 
        const ImaginovationImplementation = await ImaginovationImplementation.new() 
        await ImaginovationImplementation.initialize(token.address, operator.address, 0, 0, OneToken, dex.address) 
        const channelImplementation = await ChannelImplementation.new() 
 
        registry = await Registry.new() 
        await registry.initialize(token.address, dex.address, 1, channelImplementation.address, ImaginovationImplementation.address, ZeroAddress) 
 
        // Give some ethers for gas for operator 
        await topUpEthers(txMaker, operator.address, OneEther) 
 
        // Give tokens for txMaker so it could use them registration and lending stuff 
        await topUpTokens(token, txMaker, OneToken) 
        await token.approve(registry.address, OneToken) 
    }) 
 
    it("should register and initialize Imaginovation hub", async () => { 
        await registry.registerImaginovation(operator.address, 10, 0, Zero, OneToken, ImaginovationURL) 
        const ImaginovationId = await registry.getImaginovationAddress(operator.address) 
        expect(await registry.isImaginovation(ImaginovationId)).to.be.true 
 
        // Initialise Imaginovation object 
        Imaginovation = await ImaginovationImplementation.at(ImaginovationId) 
 
        // Topup some balance for Imaginovation 
        topUpTokens(token, Imaginovation.address, new BN(100000)) 
    }) 
 
    it("should register new provider and open Imaginovation channel", async () => { 
        const stakeAmount = new BN(888) 
        const expectedChannelId = generateChannelId(provider.address, Imaginovation.address) 
 
        // TopUp payment channel 
        const channelAddress = await registry.getChannelAddress(provider.address, Imaginovation.address) 
        await topUpTokens(token, channelAddress, stakeAmount) 
 
        // Register identity and open channel with Imaginovation 
        const signature = signIdentityRegistration(registry.address, Imaginovation.address, stakeAmount, Zero, beneficiaryA, provider) 
        await registry.registerIdentity(Imaginovation.address, stakeAmount, Zero, beneficiaryA, signature) 
        expect(await registry.isRegistered(provider.address)).to.be.true 
        expect(await Imaginovation.isChannelOpened(expectedChannelId)).to.be.true 
    }) 
 
    it("should settle into proper beneficiary", async () => { 
        const channelId = generateChannelId(provider.address, Imaginovation.address) 
        const channelState = Object.assign({}, { channelId }, await Imaginovation.channels(channelId)) 
        const amountToPay = new BN('100') 
        const balanceBefore = await token.balanceOf(beneficiaryA) 
 
        const promise = generatePromise(amountToPay, Zero, channelState, operator) 
        await Imaginovation.settlePromise(provider.address, promise.amount, promise.fee, promise.lock, promise.signature) 
 
        const balanceAfter = await token.balanceOf(beneficiaryA) 
        balanceAfter.should.be.bignumber.equal(balanceBefore.add(amountToPay)) 
    }) 
 
    it("should allow setting new beneficiary and use it in next settlement", async () => { 
        const channelId = generateChannelId(provider.address, Imaginovation.address) 
        const nonce = new BN(1) 
        const signature = signChannelBeneficiaryChange(ChainId, registry.address, beneficiaryB, nonce, provider) 
 
        // Set new beneficiary 
        await registry.setBeneficiary(provider.address, beneficiaryB, signature) 
        expect(await registry.getBeneficiary(provider.address)).to.be.equal(beneficiaryB) 
 
        // Settle into proper beneficiary address 
        const channelState = Object.assign({}, { channelId }, await Imaginovation.channels(channelId)) 
        const amountToPay = new BN('100') 
        const balanceBefore = await token.balanceOf(beneficiaryB) 
 
        const promise = generatePromise(amountToPay, Zero, channelState, operator) 
        await Imaginovation.settlePromise(provider.address, promise.amount, promise.fee, promise.lock, promise.signature) 
 
        const balanceAfter = await token.balanceOf(beneficiaryB) 
        balanceAfter.should.be.bignumber.equal(balanceBefore.add(amountToPay)) 
    }) 
 
    it("expect settleWithBeneficiary to set new beneficiary", async () => { 
        const balanceBefore = await token.balanceOf(beneficiaryC) 
        const channelId = generateChannelId(provider.address, Imaginovation.address) 
        const channelState = Object.assign({}, { channelId }, await Imaginovation.channels(channelId)) 
        const amountToPay = new BN('100') 
        const nonce = new BN(2) 
 
        beneficiaryChangeSignature = signChannelBeneficiaryChange(ChainId, registry.address, beneficiaryC, nonce, provider) // remember signature for the future 
        const promise = generatePromise(amountToPay, Zero, channelState, operator, provider.address) 
        await Imaginovation.settleWithBeneficiary(promise.identity, promise.amount, promise.fee, promise.lock, promise.signature, beneficiaryC, beneficiaryChangeSignature) 
 
        expect(await registry.getBeneficiary(provider.address)).to.be.equal(beneficiaryC) 
 
        const balanceAfter = await token.balanceOf(beneficiaryC) 
        balanceAfter.should.be.bignumber.equal(balanceBefore.add(amountToPay)) 
    }) 
 
    it("should send proper transactorFee into txMaker address", async () => { 
        const beneficiaryBalanceBefore = await token.balanceOf(beneficiaryA) 
        const txMakerBalanceBefore = await token.balanceOf(txMaker) 
        const channelId = generateChannelId(provider.address, Imaginovation.address) 
        const channelState = Object.assign({}, { channelId }, await Imaginovation.channels(channelId)) 
        const amountToPay = new BN('88') 
        const transactorFee = new BN('8') 
        const nonce = new BN(3) 
 
        const signature = signChannelBeneficiaryChange(ChainId, registry.address, beneficiaryA, nonce, provider) 
        const promise = generatePromise(amountToPay, transactorFee, channelState, operator, provider.address) 
        await Imaginovation.settleWithBeneficiary(promise.identity, promise.amount, promise.fee, promise.lock, promise.signature, beneficiaryA, signature) 
 
        expect(await registry.getBeneficiary(provider.address)).to.be.equal(beneficiaryA) 
 
        const txMakerBalanceAfter = await token.balanceOf(txMaker) 
        txMakerBalanceAfter.should.be.bignumber.equal(txMakerBalanceBefore.add(transactorFee)) 
 
        const beneficiaryBalanceAfter = await token.balanceOf(beneficiaryA) 
        beneficiaryBalanceAfter.should.be.bignumber.equal(beneficiaryBalanceBefore.add(amountToPay)) 
    }) 
 
    it("should not allow using same beneficiaryChange signature twice", async () => { 
        await registry.setBeneficiary(provider.address, beneficiaryC, beneficiaryChangeSignature).should.be.rejected 
        expect(await registry.getBeneficiary(provider.address)).to.be.equal(beneficiaryA) 
    }) 
 
    it("should settle promise into proper beneficiary for provider with zero stake", async () => { 
        const identity = wallet.generateAccount() 
        const channelId = generateChannelId(identity.address, Imaginovation.address) 
        const channelState = Object.assign({}, { channelId }, await Imaginovation.channels(channelId)) 
        const initialBalance = await token.balanceOf(beneficiaryB) 
        const amountToPay = new BN('20') 
        const nonce = (await registry.lastNonce()).add(One) 
 
        // Register identity and open channel with Imaginovation 
        const signature = signIdentityRegistration(registry.address, Imaginovation.address, Zero, Zero, beneficiaryB, identity) 
        await registry.registerIdentity(Imaginovation.address, Zero, Zero, beneficiaryB, signature) 
        expect(await registry.isRegistered(identity.address)).to.be.true 
        expect(await Imaginovation.isChannelOpened(channelId)).to.be.false 
 
        // Settle promise and open provider's channel 
        promise = generatePromise(amountToPay, Zero, channelState, operator, identity.address) 
        const beneficiaryChangeSignature = signChannelBeneficiaryChange(ChainId, registry.address, beneficiaryB, nonce, identity) // remember signature for the future 
        await Imaginovation.settleWithBeneficiary(promise.identity, promise.amount, promise.fee, promise.lock, promise.signature, beneficiaryB, beneficiaryChangeSignature) 
 
        expect(await Imaginovation.isChannelOpened(channelId)).to.be.true 
        expect(await registry.getBeneficiary(identity.address)).to.be.equal(beneficiaryB) 
 
        const balanceAfter = await token.balanceOf(beneficiaryB) 
        balanceAfter.should.be.bignumber.equal(initialBalance.add(amountToPay)) 
    }) 
}) 
