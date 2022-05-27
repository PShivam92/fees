require('chai') 
    .use(require('chai-as-promised')) 
    .should() 
const { BN } = require('web3-utils') 
 
const genCreate2Address = require('./utils/index.js').genCreate2Address 
const topUpTokens = require('./utils/index.js').topUpTokens 
const setupDEX = require('./utils/index.js').setupDEX 
const { signIdentityRegistration, signUrlUpdate } = require('./utils/client.js') 
const generateAccount = require('./utils/wallet.js').generateAccount 
 
const deployRegistry = require('../scripts/deployRegistry') 
 
const Registry = artifacts.require("Registry") 
const ChannelImplementation = artifacts.require("ChannelImplementation") 
const ImaginovationImplementation = artifacts.require("ImaginovationImplementation") 
const MystToken = artifacts.require("TestMystToken") 
 
const OneEther = web3.utils.toWei('1', 'ether') 
const OneToken = web3.utils.toWei(new BN('100000000'), 'wei') 
const Zero = new BN(0) 
const ZeroAddress = '0x0000000000000000000000000000000000000000' 
function generateIdentities(amount) { 
    return (amount <= 0) ? [generateAccount()] : [generateAccount(), ...generateIdentities(amount - 1)] 
} 
 
const identities = generateIdentities(5)   // Generates array of identities 
const operator = generateAccount() 
const ImaginovationOperator = operator.address 
const ImaginovationOperator2 = generateAccount().address 
 
contract('Deterministic registry', ([txMaker, ...otherAccounts]) => { 
    let token, channelImplementation, ImaginovationImplementation, dex, registry 
    before(async () => { 
        token = await MystToken.new() 
        dex = await setupDEX(token, txMaker) 
        channelImplementation = await ChannelImplementation.new() 
 
        const [registryAddress, ImaginovationImplementationAddress] = await deployRegistry(web3, txMaker) 
        registry = await Registry.at(registryAddress) 
        ImaginovationImplementation = await ImaginovationImplementation.at(ImaginovationImplementationAddress) 
 
        // Topup some tokens into txMaker address so it could register Imaginovation 
        await topUpTokens(token, txMaker, 10000) 
        await token.approve(registry.address, 10000) 
    }) 
 
    it('should allow to initialize not initialized registry', async () => { 
        if (! await registry.isInitialized()) { 
            expect(await registry.token()).to.be.equal(ZeroAddress) 
            await registry.initialize(token.address, dex.address, 0, channelImplementation.address, ImaginovationImplementation.address, ZeroAddress) 
 
            expect(await registry.token()).to.be.equal(token.address) 
            expect(await registry.dex()).to.be.equal(dex.address) 
            expect(await registry.getChannelImplementation()).to.be.equal(channelImplementation.address) 
            expect(await registry.getImaginovationImplementation()).to.be.equal(ImaginovationImplementation.address) 
            expect(await registry.token()).to.be.equal(token.address) 
            expect(await registry.owner()).to.be.equal(txMaker) 
        } 
        expect(await registry.isInitialized()).to.be.true 
    }) 
 
    it('should reject attempt to initialize already initialized registry', async () => { 
        expect(await registry.isInitialized()).to.be.true 
        await registry.initialize(token.address, dex.address, 10, channelImplementation.address, ImaginovationImplementation.address, ZeroAddress).should.be.rejected 
    }) 
 
    it('should have Imaginovation implementation deployed into deterministic address', async () => { 
        const expectedAddress = '0xB6D6838664c7DB04Fe33F0E2EeD950Ac17a3dcbD' 
        expect(await registry.getImaginovationImplementation()).to.be.equal(expectedAddress) 
    }) 
}) 
 
contract('Registry', ([txMaker, minter, fundsDestination, ...otherAccounts]) => { 
    let token, channelImplementation, ImaginovationImplementation, ImaginovationId, dex, registry 
    before(async () => { 
        token = await MystToken.new() 
        dex = await setupDEX(token, txMaker) 
        ImaginovationImplementation = await ImaginovationImplementation.new() 
        channelImplementation = await ChannelImplementation.new() 
 
        registry = await Registry.new() 
        await registry.initialize(token.address, dex.address, 0, channelImplementation.address, ImaginovationImplementation.address, ZeroAddress) 
 
        // Topup some tokens into txMaker address so it could register Imaginovation 
        await topUpTokens(token, txMaker, 10000) 
        await token.approve(registry.address, 10000) 
    }) 
 
    it('should register Imaginovation', async () => { 
        const ImaginovationURL = Buffer.from('http://test.Imaginovation') 
        await registry.registerImaginovation(ImaginovationOperator, 10, 0, 25, OneToken, ImaginovationURL) 
        ImaginovationId = await registry.getImaginovationAddress(ImaginovationOperator) 
        expect(await registry.isImaginovation(ImaginovationId)).to.be.true 
    }) 
 
    it('Imaginovation should have proper URL', async () => { 
        const expectedURL = 'http://test.Imaginovation' 
        expect(Buffer.from((await registry.getImaginovationURL(ImaginovationId)).slice(2), 'hex').toString()).to.be.equal(expectedURL) 
    }) 
 
    it('should be possible to change Imaginovation URL', async () => { 
        const newURL = 'https://test.Imaginovation/api/v2' 
        const nonce = new BN(0) 
        const signature = signUrlUpdate(registry.address, ImaginovationId, newURL, nonce, operator) 
        await registry.updateImaginovationURL(ImaginovationId, Buffer.from(newURL), signature) 
 
        expect(Buffer.from((await registry.getImaginovationURL(ImaginovationId)).slice(2), 'hex').toString()).to.be.equal(newURL) 
    }) 
 
    it('should register identity having 0 balance', async () => { 
        const identity = identities[0] 
        const identityHash = identity.address 
        const signature = signIdentityRegistration(registry.address, ImaginovationId, Zero, Zero, fundsDestination, identity) 
 
        expect(await registry.isRegistered(identityHash)).to.be.false 
        await registry.registerIdentity(ImaginovationId, Zero, Zero, fundsDestination, signature) 
        expect(await registry.isRegistered(identityHash)).to.be.true 
    }) 
 
    it('should reject second attempt to create same channel', async () => { 
        const identity = identities[0] 
        const signature = signIdentityRegistration(registry.address, ImaginovationId, Zero, Zero, fundsDestination, identity) 
        await registry.registerIdentity(ImaginovationId, Zero, Zero, fundsDestination, signature).should.be.rejected 
    }) 
 
    it('should reject registration with different beneficiary for already registered identity', async () => { 
        const identity = identities[0] 
        const beneficiary = otherAccounts[0] 
 
        expect(await registry.isRegistered(identity.address)).to.be.true 
 
        const signature = signIdentityRegistration(registry.address, ImaginovationId, Zero, Zero, beneficiary, identity) 
        await registry.registerIdentity(ImaginovationId, Zero, Zero, beneficiary, signature).should.be.rejected 
    }) 
 
    it('identity contract should be deployed into predefined address and be EIP1167 proxy', async () => { 
        const identityHash = identities[0].address 
        const channelAddress = await genCreate2Address(identityHash, ImaginovationId, registry, channelImplementation.address) 
        const byteCode = await web3.eth.getCode(channelAddress) 
 
        // We're expecting EIP1167 minimal proxy pointing into identity implementation address 
        const expectedByteCode = [ 
            '0x363d3d373d3d3d363d73', 
            channelImplementation.address.slice(2), 
            '5af43d82803e903d91602b57fd5bf3' 
        ].join('').toLocaleLowerCase() 
 
        expect(byteCode).to.be.equal(expectedByteCode) 
    }) 
 
    it("should fail registering identity with unregistered Imaginovation", async () => { 
        const unregisteredImaginovation = (await ImaginovationImplementation.new()).address 
        const identity = identities[4] 
 
        expect(await registry.isRegistered(identity.address)).to.be.false 
        const signature = signIdentityRegistration(registry.address, unregisteredImaginovation, Zero, Zero, fundsDestination, identity) 
        await registry.registerIdentity(unregisteredImaginovation, Zero, Zero, fundsDestination, signature).should.be.rejected 
        expect(await registry.isRegistered(identity.address)).to.be.false 
    }) 
 
    // ==================== Paid registration ====================== 
 
    it('should fail registering identity having 0 balance', async () => { 
        const txFee = 1 
        const secondIdentity = identities[1] 
        const secondIdentityHash = secondIdentity.address 
        const channelAddress = await genCreate2Address(secondIdentityHash, ImaginovationId, registry, channelImplementation.address) 
        expect(Number(await token.balanceOf(channelAddress))).to.be.equal(0) 
 
        const signature = signIdentityRegistration(registry.address, ImaginovationId, Zero, txFee, fundsDestination, secondIdentity) 
        await registry.registerIdentity(ImaginovationId, Zero, txFee, fundsDestination, signature).should.be.rejected 
        expect(await registry.isRegistered(secondIdentityHash)).to.be.false 
    }) 
 
    it('should register identity which has coins', async () => { 
        const txFee = 100 
        const secondIdentity = identities[1] 
        const secondIdentityHash = secondIdentity.address 
        const channelAddress = await genCreate2Address(secondIdentityHash, ImaginovationId, registry, channelImplementation.address) 
        expect(Number(await token.balanceOf(channelAddress))).to.be.equal(0) 
 
        // TopUp channel -> send or mint tokens into channel address 
        const topUpAmount = 1000000 
        await token.mint(channelAddress, topUpAmount) 
        expect(Number(await token.balanceOf(channelAddress))).to.be.equal(topUpAmount) 
 
        // Register identity 
        const signature = signIdentityRegistration(registry.address, ImaginovationId, Zero, txFee, fundsDestination, secondIdentity) 
        await registry.registerIdentity(ImaginovationId, Zero, txFee, fundsDestination, signature) 
        expect(await registry.isRegistered(secondIdentityHash)).to.be.true 
    }) 
 
    it("should send transaction fee for txMaker", async () => { 
        const thirdIdentity = identities[2] 
        const thirdIdentityHash = thirdIdentity.address 
        const channelAddress = await genCreate2Address(thirdIdentityHash, ImaginovationId, registry, channelImplementation.address) 
        const transactionFee = new BN(5) 
        const balanceBefore = await token.balanceOf(txMaker) 
 
        // TopUp channel -> send or mint tokens into channel address 
        const topUpAmount = 1000000 
        await token.mint(channelAddress, topUpAmount) 
        expect(Number(await token.balanceOf(channelAddress))).to.be.equal(topUpAmount) 
 
        // Register identity 
        const signature = signIdentityRegistration(registry.address, ImaginovationId, Zero, transactionFee, fundsDestination, thirdIdentity) 
        await registry.registerIdentity(ImaginovationId, Zero, transactionFee, fundsDestination, signature) 
        expect(await registry.isRegistered(thirdIdentityHash)).to.be.true 
 
        // txMaker should own some tokens 
        expect(Number(await token.balanceOf(txMaker))).to.be.equal(balanceBefore.add(transactionFee).toNumber()) 
    }) 
 
    // ==================== Implementation versioning ====================== 
 
    it("should be possible to set second implementation version", async () => { 
        channelImplementation2 = await ChannelImplementation.new() 
        ImaginovationImplementation2 = await ImaginovationImplementation.new() 
 
        await registry.setImplementations(channelImplementation2.address, ImaginovationImplementation2.address) 
 
        expect((await registry.getLastImplVer()).toNumber()).to.be.equal(1) 
        expect(await registry.getChannelImplementation()).to.be.equal(channelImplementation2.address) 
        expect(await registry.getImaginovationImplementation()).to.be.equal(ImaginovationImplementation2.address) 
    }) 
 
    it("should be able to register Imaginovation for previously unknown operator", async () => { 
        const ImaginovationURL = Buffer.from('http://test.Imaginovation') 
        await registry.registerImaginovation(ImaginovationOperator2, 10, 0, 25, OneToken, ImaginovationURL) 
        Imaginovation2Id = await registry.getImaginovationAddress(ImaginovationOperator2) 
        expect(await registry.isImaginovation(Imaginovation2Id)).to.be.true 
    }) 
 
    it("same operator should be able to register second Imaginovation with new implementations", async () => { 
        const ImaginovationURL = Buffer.from('http://test.Imaginovation') 
        await registry.registerImaginovation(ImaginovationOperator, 10, 0, 25, OneToken, ImaginovationURL) 
        Imaginovation3Id = await registry.getImaginovationAddress(ImaginovationOperator) 
        expect(await registry.isImaginovation(Imaginovation3Id)).to.be.true 
    }) 
 
    it("should fail to register one more Imaginovation with same implementation", async () => { 
        const ImaginovationURL = Buffer.from('http://test2.Imaginovation') 
        await registry.registerImaginovation(ImaginovationOperator, 10, 0, 25, OneToken, ImaginovationURL).should.be.rejected 
    }) 
 
    it('should register identity with v2 channel', async () => { 
        const identity = identities[3] 
        const identityHash = identity.address 
        const signature = signIdentityRegistration(registry.address, Imaginovation3Id, Zero, Zero, fundsDestination, identity) 
 
        expect(await registry.isRegistered(identityHash)).to.be.false 
        await registry.registerIdentity(Imaginovation3Id, Zero, Zero, fundsDestination, signature) 
        expect(await registry.isRegistered(identityHash)).to.be.true 
    }) 
 
    it('registered identity can have v2 channel as well', async () => { 
        const identity = identities[0] 
        const identityHash = identity.address 
        expect(await registry.isRegistered(identityHash)).to.be.true 
 
        const signature = signIdentityRegistration(registry.address, Imaginovation3Id, Zero, Zero, fundsDestination, identity) 
        await registry.registerIdentity(Imaginovation3Id, Zero, Zero, fundsDestination, signature) 
 
        // Recheck that both identities channels are still there 
        const chOld = await ChannelImplementation.at(await registry.getChannelAddress(identityHash, ImaginovationId)) 
        expect(await chOld.isInitialized()).to.be.true 
 
        const chNew = await ChannelImplementation.at(await registry.getChannelAddress(identityHash, Imaginovation3Id)) 
        expect(await chNew.isInitialized()).to.be.true 
 
        expect(chOld.address).to.be.not.equal(chNew.address) 
    }) 
 
    it("should fail setting wrong implementation address", async () => { 
        fakeChannelImplementation = generateAccount().address 
        fakeImaginovationImplementation = generateAccount().address 
        await registry.setImplementations(fakeChannelImplementation, fakeImaginovationImplementation).should.be.rejected 
    }) 
 
    it("only owner should be able to set new implementation", async () => { 
        const channelImplementation3 = await ChannelImplementation.new() 
        const ImaginovationImplementation3 = await ImaginovationImplementation.new() 
 
        // Anyone else except owner should be rejected 
        await registry.setImplementations( 
            channelImplementation3.address, 
            ImaginovationImplementation3.address, 
            { from: otherAccounts[0] } 
        ).should.be.rejected 
 
        await registry.setImplementations( 
            channelImplementation3.address, 
            ImaginovationImplementation3.address, { from: await registry.owner() } 
        ) 
        expect((await registry.getLastImplVer()).toNumber()).to.be.equal(2) 
    }) 
 
    // ==================== Other functionality ====================== 
 
    it("`isImaginovation` should return proper answer if given address is registered Imaginovation", async () => { 
        const Imaginovation = { 
            operator: generateAccount(), 
            identity: '0x0', // will be set later 
            url: Buffer.from('http://test.Imaginovation'), 
        } 
 
        await registry.registerImaginovation(Imaginovation.operator.address, 10, 0, 25, OneToken, Imaginovation.url) 
        Imaginovation.identity = await registry.getImaginovationAddress(Imaginovation.operator.address) 
        expect(await registry.isImaginovation(Imaginovation.identity)).to.be.true 
 
        const unregisteredImaginovation = await ImaginovationImplementation.new() 
        expect(await registry.isImaginovation(unregisteredImaginovation.address)).to.be.false 
    }) 
 
    it('should revert when ethers are sent to registry', async () => { 
        await registry.sendTransaction({ 
            from: minter, 
            value: OneEther, 
            gas: 20000000000 
        }).should.be.rejected 
    }) 
 
    it('registry should have proper channel address calculations', async () => { 
        const identityHash = identities[0].address 
        expect( 
            await genCreate2Address(identityHash, ImaginovationId, registry, channelImplementation.address) 
        ).to.be.equal( 
            (await registry.getChannelAddress(identityHash, ImaginovationId)).toLowerCase() 
        ) 
    }) 
}) 
