import { expect } from 'chai'
import VariantReassignment from '../../../lib/runner/variant-reassignment'
import * as utils from '../../utils/helper'

const productDraftProductType = require('../../resources/productType.json')

describe('Variant reassignment', () => {
  const logger = utils.createLogger(__filename)
  let ctpClient
  let product1
  let product2

  before(async () => {
    ctpClient = await utils.createClient()
    const productType = await utils.ensureProductType(ctpClient)
    const productDraft1 = utils.generateProduct(['1', '2'], productType.id)
    product1 = await utils.ensureResource(ctpClient.products, productDraft1)
    const productDraft2 = utils.generateProduct(['3', '4'], productType.id)
    product2 = await utils.ensureResource(ctpClient.products, productDraft2)
  })

  after(() =>
    utils.deleteResourcesAll(ctpClient, logger)
  )

  it('moving variant v3 + removing variant v2 + changing productType', async () => {
    productDraftProductType.name = 'product-draft-product-type'
    const productType = await utils.ensureResource(ctpClient.productTypes, productDraftProductType)

    const reassignment = new VariantReassignment([], logger, {})
    await reassignment.execute([{
      productType: {
        id: productType.id
      },
      key: 'sample-product1',
      name: {
        en: 'Sample product1'
      },
      slug: {
        en: 'sample-product1'
      },
      masterVariant: {
        sku: '1',
        prices: []
      },
      variants: [
        {
          sku: '3',
          prices: []
        }
      ]
    }], [product1, product2])
    const { body: { results } } = await ctpClient.productProjections
      .staged(true)
      .where('masterVariant(sku in ("1", "2", "3", "4"))')
      .where('variants(sku in ("1", "2", "3", "4"))')
      .whereOperator('or')
      .fetch()
    expect(results).to.have.lengthOf(2)
    const backupProduct = results.find(product => product.masterVariant.sku === '2')
    expect(backupProduct).to.be.an('object')
    expect(backupProduct.variants).to.have.lengthOf(2)

    const newProduct = results.find(product => product.masterVariant.sku === '1')
    expect(newProduct.productType.id).to.not.equal(product1.productType.id)
  })
})
