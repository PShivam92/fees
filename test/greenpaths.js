/* 
    In this file we'll have a few end-to-end workflows which emulates all necesary 
    on-chain and off-chain interactions from registering identity, to settlement of received funds 
*/ 
 
const { BN } = require('web3-utils') 
const { 
    topUpTokens, 
    topUpEthers, 
    setupDEX, 
    generateChannelId 
} = require('./utils/index.js') 
const { 
    createImaginovationService, 
    createConsumer, 
    createProvider, 
    signIdentityRegistration 
} = require('./utils/client.js') 
const wallet = require('./utils/wallet.js') 
const { expect } = require('chai') 
 
const MystToken = artifacts.require("TestMystToken") 
const Registry = artifacts.require("Registry") 
const ImaginovationImplementation = artifacts.require("TestImaginovationImplementation") 
const ChannelImplementation = artifacts.require("ChannelImplementation") 
 
const OneToken = web3.utils.toWei(new BN('100000000'), 'wei') 
const OneEther = web3.utils.toWei(new BN(1), 'ether') 
const Zero = new BN(0) 
const ZeroAddress = '0x0000000000000000000000000000000000000000' 
const ImaginovationURL = Buffer.from('http://test.Imaginovation') 
const Imaginovation2URL = Buffer.from('https://test.Imaginovation2') 
 
let token, Imaginovation, registry; 
const identities = generateIdentities(6)   // Generates array of identities 
const operator = wallet.generateAccount()  // Generate Imaginovation operator wallet 
const operator2 = wallet.generateAccount() // Generate operator for second Imaginovation 
 
function generateIdentities(amount) { 
    return (amount <= 0) ? [wallet.generateAccount()] : [wallet.generateAccount(), ...generateIdentities(amount - 1)] 
} 
 
async function pay(consumer, provider, ImaginovationService, amount, repetitions = 1) { 
    const agreementId = provider.generateInvoice(new BN(0)).agreementId 
    for (let i = 0; i < repetitions; i++) { 
        const invoice = provider.generateInvoice(amount, agreementId) 
        const exchangeMsg = consumer.createExchangeMsg(invoice, provider.identity.address) 
        const promise = await ImaginovationService.exchangePromise(exchangeMsg, consumer.identity.pubKey, provider.identity.address) 
        provider.savePromise(promise) 
    } 
} 
 
contract('Green path tests', ([txMaker, ...beneficiaries]) => { 
    before(async () => { 
        token = await MystToken.new() 
        const dex = await setupDEX(token, txMaker) 
        const ImaginovationImplementation = await ImaginovationImplementation.new() 
        const channelImplementation = await ChannelImplementation.new() 
        registry = await Registry.new() 
        await registry.initialize(token.address, dex.address, 1, channelImplementation.address, ImaginovationImplementation.address, ZeroAddress) 
 
        // Give some ethers for gas for operator 
        await topUpEthers(txMaker, operator.address, OneEther) 
 
        // Give tokens for txMaker so it could use them registration and lending stuff 
        await topUpTokens(token, txMaker, OneToken) 
        await token.approve(registry.address, OneToken) 
    }) 
 
    // Ask tx-maker to make tx +  sign cheque for him for that. Works even with registration fee stuff. 
    it("register and initialize Imaginovation", async () => { 
        await registry.registerImaginovation(operator.address, 10, 0, 25, OneToken, ImaginovationURL) 
        const ImaginovationId = await registry.getImaginovationAddress(operator.address) 
        expect(await registry.isImaginovation(ImaginovationId)).to.be.true 
 
        // Initialise Imaginovation object and give initial available balance 
        Imaginovation = await ImaginovationImplementation.at(ImaginovationId) 
        await topUpTokens(token, ImaginovationId, OneToken) 
    }) 
 
    it("register consumer identities", async () => { 
        // First four identities are consumer identities 
        for (let i = 0; i < 4; i++) { 
            const signature = signIdentityRegistration(registry.address, Imaginovation.address, Zero, Zero, beneficiaries[i], identities[i]) 
            await registry.registerIdentity(Imaginovation.address, Zero, Zero, beneficiaries[i], signature) 
            expect(await registry.isRegistered(identities[i].address)).to.be.true 
        } 
    }) 
 
    it("register provider identity and open incoming channel with Imaginovation", async () => { 
        const providerIdentity = identities[4].address 
        const expectedChannelId = generateChannelId(providerIdentity, Imaginovation.address) 
        const initialImaginovationBalance = await token.balanceOf(Imaginovation.address) 
 
        // Guaranteed incomming channel size 
        const channelStake = new BN(2000) 
 
        // Topup some tokens into paying channel 
        const channelAddress = await registry.getChannelAddress(providerIdentity, Imaginovation.address) 
        await topUpTokens(token, channelAddress, OneToken) 
 
        // Register identity and open channel with Imaginovation 
        const signature = signIdentityRegistration(registry.address, Imaginovation.address, channelStake, Zero, beneficiaries[4], identities[4]) 
        await registry.registerIdentity(Imaginovation.address, channelStake, Zero, beneficiaries[4], signature) 
        expect(await registry.isRegistered(providerIdentity)).to.be.true 
        expect(await Imaginovation.isChannelOpened(expectedChannelId)).to.be.true 
 
        // Channel stake have to be transfered to Imaginovation 
        const ImaginovationTokenBalance = await token.balanceOf(Imaginovation.address) 
        ImaginovationTokenBalance.should.be.bignumber.equal(initialImaginovationBalance.add(channelStake)) 
    }) 
 
    it("register provider identity and transfer fee to transactor", async () => { 
        const providerIdentity = identities[5].address 
        const expectedChannelId = generateChannelId(providerIdentity, Imaginovation.address) 
        const initialImaginovationBalance = await token.balanceOf(Imaginovation.address) 
 
        // Guaranteed incomming channel size 
        const channelStake = new BN(2000) 
 
        // Topup some tokens into paying channel 
        const channelAddress = await registry.getChannelAddress(providerIdentity, Imaginovation.address) 
        await topUpTokens(token, channelAddress, OneToken) 
 
        // Save current token balance 
        const txMakerTokenBalance = await token.balanceOf(txMaker) 
        const fee = new BN(100) 
 
        // Register identity and open channel with Imaginovation 
        const signature = signIdentityRegistration(registry.address, Imaginovation.address, channelStake, fee, beneficiaries[5], identities[5]) 
        await registry.registerIdentity(Imaginovation.address, channelStake, fee, beneficiaries[5], signature) 
        expect(await registry.isRegistered(providerIdentity)).to.be.true 
        expect(await Imaginovation.isChannelOpened(expectedChannelId)).to.be.true 
 
        // Channel stake have to be transfered to Imaginovation 
        const ImaginovationTokenBalance = await token.balanceOf(Imaginovation.address) 
        ImaginovationTokenBalance.should.be.bignumber.equal(initialImaginovationBalance.add(channelStake)) 
 
        const newTxMakerTokenBalance = await token.balanceOf(txMaker) 
        expect(newTxMakerTokenBalance.toNumber()).to.be.equal(txMakerTokenBalance.toNumber() + fee.toNumber()) 
    }) 
 
    it("topup consumer channels", async () => { 
        for (let i = 0; i < 4; i++) { 
            const channelId = await registry.getChannelAddress(identities[i].address, Imaginovation.address) 
            const amount = new BN(10000) 
            await token.transfer(channelId, amount) 
 
            const channelTotalBalance = await token.balanceOf(channelId) 
            channelTotalBalance.should.be.bignumber.equal(amount) 
        } 
    }) 
 
    it("shoud successfylly pay through Imaginovation", async () => { 
        const consumer = await createConsumer(registry, identities[0], Imaginovation.address) 
        const provider = await createProvider(identities[4], Imaginovation) 
        const ImaginovationService = await createImaginovationService(Imaginovation, operator, token) 
        const amount = new BN(10) 
 
        // Provider generates invoice 
        const invoice = provider.generateInvoice(amount) 
 
        // Consumer generates payment promise and exchange message 
        const exchangeMsg = consumer.createExchangeMsg(invoice, provider.identity.address) 
 
        // Provider validates exchange message 
        provider.validateExchangeMessage(exchangeMsg, consumer.identity.pubKey) 
 
        // Exchange given message into payment promise from Imaginovation 
        const promise = await ImaginovationService.exchangePromise(exchangeMsg, consumer.identity.pubKey, provider.identity.address) 
 
        // settle promise on-chain 
        await provider.settlePromise(promise) 
 
        const beneficiaryBalance = await token.balanceOf(beneficiaries[4]) 
        beneficiaryBalance.should.be.bignumber.equal(amount) 
    }) 
 
    it("should properly aggregate payments for provider", async () => { 
        const consumer1 = await createConsumer(registry, identities[0], Imaginovation.address) 
        const consumer2 = await createConsumer(registry, identities[1], Imaginovation.address) 
        const consumer3 = await createConsumer(registry, identities[2], Imaginovation.address) 
        const provider = await createProvider(identities[4], Imaginovation) 
        const ImaginovationService = await createImaginovationService(Imaginovation, operator, token) 
 
        // Let's do a few payments by different consumers 
        await pay(consumer1, provider, ImaginovationService, new BN(77), 3) 
        await pay(consumer2, provider, ImaginovationService, new BN(900), 1) 
        await pay(consumer3, provider, ImaginovationService, new BN(1), 20) 
        await pay(consumer1, provider, ImaginovationService, new BN(10), 1) 
 
        // check aggregated promise amount 
        provider.getBiggestPromise().amount.should.be.bignumber.equal('1161') 
 
        // settle biggest promise 
        await provider.settlePromise() 
 
        const beneficiaryBalance = await token.balanceOf(beneficiaries[4]) 
        beneficiaryBalance.should.be.bignumber.equal('1161') 
    }) 
 
    it('should register second Imaginovation', async () => { 
        await registry.registerImaginovation(operator2.address, 10, 0, 0, OneToken, Imaginovation2URL) 
        const ImaginovationId = await registry.getImaginovationAddress(operator2.address) 
        expect(await registry.isImaginovation(ImaginovationId)).to.be.true 
 
        // Initialise Imaginovation object 
        Imaginovation2 = await ImaginovationImplementation.at(ImaginovationId) 
 
        // Topup some tokens into Imaginovation2 
        await topUpTokens(token, Imaginovation2.address, OneToken) 
    }) 
 
    it("should allow for any registered identity to settle promise even when there is zero stake in Imaginovation2", async () => { 
        const ImaginovationService = await createImaginovationService(Imaginovation2, operator2, token) 
        const provider = await createProvider(identities[1], Imaginovation2) 
        const amountToPay = new BN('25') 
 
        // Register and topup consumer channel 
        const signature = signIdentityRegistration(registry.address, Imaginovation2.address, Zero, Zero, beneficiaries[0], identities[0]) 
        await registry.registerIdentity(Imaginovation2.address, Zero, Zero, beneficiaries[0], signature) 
        expect(await registry.isRegistered(identities[0].address)).to.be.true 
        const consumer = await createConsumer(registry, identities[0], Imaginovation2.address) 
        const channelChannelId = await registry.getChannelAddress(identities[0].address, Imaginovation2.address) 
        await token.transfer(channelChannelId, amountToPay) // Topup consumer channel 
 
        // Provider generates invoice 
        const invoice = provider.generateInvoice(amountToPay) 
 
        // Consumer generates payment promise and exchange message 
        const exchangeMsg = consumer.createExchangeMsg(invoice, provider.identity.address) 
 
        // Provider validates exchange message 
        provider.validateExchangeMessage(exchangeMsg, consumer.identity.pubKey) 
 
 
        // Exchange given message into payment promise from Imaginovation 
        const promise = await ImaginovationService.exchangePromise(exchangeMsg, consumer.identity.pubKey, provider.identity.address) 
 
        // settle promise on-chain 
        await provider.settlePromise(promise) 
 
        const providerBeneficiary = await registry.getBeneficiary(identities[1].address) 
        const beneficiaryBalance = await token.balanceOf(providerBeneficiary) 
        beneficiaryBalance.should.be.bignumber.equal(amountToPay) 
    }) 
 
}) 
