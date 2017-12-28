import { expect } from 'chai'
import * as utils from '../../utils/helper'
import VariantReassignment from '../../../lib/runner/variant-reassignment'
import { PRODUCT_ANONYMIZE_SLUG_KEY } from '../../../lib/constants'

/* eslint-disable max-len */
/**
 +---------+----------------------------+----------------------------+--------------------+----------------------------+------------------------------------------------------------+
 |         |        Product draft       |         CTP product        | After reassignment |         CTP product        |                         CTP product                        |
 +---------+----------------------------+----------------------------+                    +----------------------------+------------------------------------------------------------+
 | Staged  | Product:                   | Product:                   |                    | Product:                   | Product:id: 2                                              |
 |         | slug: { en: "product" }    | id: 1                      |                    | id: 1                      | slug: { en: "product-${timestamp}", ctsd: "${timestamp} }  |
 |         | product-type: "pt2"        | slug: { en: "product" }    |                    | slug: { en: "product" }    | product-type: "pt2"                                        |
 |         | masterVariant: { sku: v1 } | product-type: "pt2"        |                    | product-type: "pt2"        | masterVariant: { sku: v5 }                                 |
 |         |                            | masterVariant: { sku: v1 } |                    | masterVariant: { sku: v1 } |                                                            |
 +---------+----------------------------+----------------------------+                    +----------------------------+------------------------------------------------------------+
 | Current |                            | Product:                   |                    | Product:                   |                                                            |
 |         |                            | id: 1                      |                    | id: 1                      |                                                            |
 |         |                            | slug: { en: "product" }    |                    | slug: { en: "product" }    |                                                            |
 |         |                            | product-type: "pt2"        |                    | product-type: "pt2"        |                                                            |
 |         |                            | masterVariant: { sku: v5 } |                    | masterVariant: { sku: v1 } |                                                            |
 +---------+----------------------------+----------------------------+--------------------+----------------------------+------------------------------------------------------------+
 */
/* eslint-enable max-len */
// todo: this test is similar to test 13, maybe we need only 1 test
describe.skip('Variant reassignment', () => {
  const logger = utils.createLogger(__filename)
  let ctpClient
  let product1

  before(async () => {
    ctpClient = await utils.createClient()

    let product1Response = await utils.createCtpProducts([['5']], ctpClient)
    product1 = product1Response[0]
    product1Response = await ctpClient.products
      .byId(product1.id)
      .update({
        version: product1.version,
        actions: [{ action: 'publish' }]
      })
    product1Response = await ctpClient.products
      .byId(product1.id)
      .update({
        version: product1Response.body.version,
        actions: [
          {
            action: 'addVariant',
            sku: '1'
          },
          {
            action: 'changeMasterVariant',
            sku: '1'
          },
          {
            action: 'removeVariant',
            sku: '5'
          }
        ]
      })
  })

  after(async () => {
    await utils.unpublishAllProducts(ctpClient, logger)
    await utils.deleteResourcesAll(ctpClient, logger)
  })

  it('different variants in staged and current for one product', async () => {
    const reassignment = new VariantReassignment(ctpClient, logger)
    await reassignment.execute([{
      productType: product1.productType,
      name: product1.name,
      slug: product1.slug,
      masterVariant: {
        sku: '1'
      },
      variants: [{}]
    }], [product1])
    const { body: product1After } = await ctpClient.products.byId(product1.id).fetch()
    expect(product1After.masterData.staged.masterVariant.sku).to.equal('1')
    expect(product1After.masterData.current.masterVariant.sku).to.equal('1')

    const { body: { backupProduct } } = await utils.getProductsBySkus(['5'], ctpClient)
    expect(backupProduct.slug[PRODUCT_ANONYMIZE_SLUG_KEY]).to.be.a('string')
    expect(backupProduct.masterData.staged.variants.length).to.equal(0)
  })
})
