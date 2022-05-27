require('chai') 
    .use(require('chai-as-promised')) 
    .should() 
const {BN} = require('web3-utils') 
 
const { topUpTokens, setupDEX, sleep } = require('./utils/index.js') 
const { 
    signIdentityRegistration, 
    signChannelBalanceUpdate, 
    signChannelImaginovationReturnRequest, 
    createPromise 
} = require('./utils/client.js') 
const wallet = require('./utils/wallet.js') 
 
const MystToken = artifacts.require("TestMystToken") 
const Registry = artifacts.require("Registry") 
const ImaginovationImplementation = artifacts.require("TestImaginovationImplementation") 
const ChannelImplementation = artifacts.require("ChannelImplementation") 
 
const OneToken = web3.utils.toWei(new BN('100000000'), 'wei') 
const Zero = new BN(0) 
const ZeroAddress = '0x0000000000000000000000000000000000000000' 
const ImaginovationURL = Buffer.from('http://test.Imaginovation') 
 
const operatorPrivKey = Buffer.from('d6dd47ec61ae1e85224cec41885eec757aa77d518f8c26933e5d9f0cda92f3c3', 'hex') 
const ImaginovationOperator = wallet.generateAccount(operatorPrivKey) 
 
contract('Imaginovation closing', ([txMaker, operatorAddress, ...beneficiaries]) => { 
    let token, Imaginovation, registry, stake 
    before(async () => { 
        stake = OneToken 
 
        token = await MystToken.new() 
        const dex = await setupDEX(token, txMaker) 
        const ImaginovationImplementation = await ImaginovationImplementation.new(token.address, ImaginovationOperator.address, 0, OneToken) 
        const channelImplementation = await ChannelImplementation.new() 
        registry = await Registry.new() 
        await registry.initialize(token.address, dex.address, stake, channelImplementation.address, ImaginovationImplementation.address, ZeroAddress) 
 
        // Topup some tokens into txMaker address so it could register Imaginovation 
        await topUpTokens(token, txMaker, OneToken) 
        await token.approve(registry.address, OneToken) 
    }) 
 
    it('should register Imaginovation', async () => { 
        await registry.registerImaginovation(ImaginovationOperator.address, stake, Zero, 25, OneToken, ImaginovationURL) 
        const ImaginovationId = await registry.getImaginovationAddress(ImaginovationOperator.address) 
        Imaginovation = await ImaginovationImplementation.at(ImaginovationId) 
        expect(await registry.isImaginovation(Imaginovation.address)).to.be.true 
    }) 
 
    it('should be able to close Imaginovation', async () => { 
        const initialBalance = await token.balanceOf(Imaginovation.address) 
        expect((await Imaginovation.getStatus()).toNumber()).to.be.equal(0)  // 0 - Active, 1 - Paused, 2 - Punishment, 3 - Closed 
        await Imaginovation.closeImaginovation({ from: operatorAddress }) 
        expect((await Imaginovation.getStatus()).toNumber()).to.be.equal(3)  // 0 - Active, 1 - Paused, 2 - Punishment, 3 - Closed 
        const currentBalance = await token.balanceOf(Imaginovation.address) 
        initialBalance.should.be.bignumber.equal(currentBalance) 
    }) 
 
    it('should fail getting stake back until timelock passes', async () => { 
        const expectedBlockNumber = (await web3.eth.getBlock('latest')).number + 4 
        expect((await web3.eth.getBlock('latest')).number).to.be.below(expectedBlockNumber) 
        await Imaginovation.getStakeBack(beneficiaries[0], { from: operatorAddress }).should.be.rejected 
    }) 
 
    it('should allow to get stake back after timelock passes', async () => { 
        const initialImaginovationBalance = await token.balanceOf(Imaginovation.address) 
        const expectedBlockTime = (await web3.eth.getBlock('latest')).timestamp + 1 
 
        // Wait till time will pass and procude new block 
        await sleep(3000) 
        await Imaginovation.moveBlock() 
        expect((await web3.eth.getBlock('latest')).timestamp).to.be.above(expectedBlockTime) 
 
        await Imaginovation.getStakeBack(beneficiaries[0], { from: operatorAddress }) 
 
        const currentImaginovationBalance = await token.balanceOf(Imaginovation.address) 
        const beneficiaryBalance = await token.balanceOf(beneficiaries[0]) 
        beneficiaryBalance.should.be.bignumber.equal(initialImaginovationBalance) 
        currentImaginovationBalance.should.be.bignumber.equal(Zero) 
    }) 
 
}) 