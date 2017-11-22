import { expect } from 'chai'
import * as utils from '../../utils/helper'
import VariantReassignment from '../../../lib/runner/variant-reassignment'

/* eslint-disable max-len */
/**
 * +-------------+------------------------------------------------------------+-------------------------------------------------------------------------+--------------------+--------------------------------------------+
 * | Blacklist   | Product draft                                              | CTP product                                                             | After reassignment | CTP product                                |
 * +-------------+------------------------------------------------------------+-------------------------------------------------------------------------+                    +--------------------------------------------+
 * | [ brandId ] | Product:                                                   | Product:                                                                |                    | Product:                                   |
 * |             | slug: { en: "product" }                                    | id: 1                                                                   |                    | id: "1"                                    |
 * |             | product-type: "pt1"                                        | slug: { en: "product-1" }                                               |                    | slug: { en: "product" }                    |
 * |             | masterVariant: { sku: v1, attributes: [ { brandId: 1 } ] } | product-type: "pt1"                                                     |                    | product-type: "pt1"                        |
 * |             | variants: { sku: v2, attributes: [ { brandId: 1 } ] }      | masterVariant: { sku: v1, attributes: [ { brandId (sameForAll): 2 } ] } |                    | masterVariant: { sku: v1, attributes: [] } |
 * |             |                                                            |                                                                         |                    | variants: { sku: v2, attributes: [] }      |
 * +-------------+------------------------------------------------------------+-------------------------------------------------------------------------+                    +--------------------------------------------+
 * |             |                                                            | Product:                                                                |                    |                                            |
 * |             |                                                            | id: 2                                                                   |                    |                                            |
 * |             |                                                            | slug: { en: "product-2" }                                               |                    |                                            |
 * |             |                                                            | product-type: "pt1"                                                     |                    |                                            |
 * |             |                                                            | masterVariant: { sku: v2, attributes: [ { brandId (sameForAll): 3 } ] } |                    |                                            |
 * +-------------+------------------------------------------------------------+-------------------------------------------------------------------------+--------------------+--------------------------------------------+
 */
/* eslint-enable max-len */
describe('Variant reassignment', () => {
  const logger = utils.createLogger(__filename)
  let ctpClient
  let product1
  let product2

  before(async () => {
    ctpClient = await utils.createClient()
    const productType = await utils.ensureProductType(ctpClient)
    const productDraft1 = utils.generateProduct(['1'], productType.id)
    productDraft1.masterVariant.attributes = [{ name: 'brandId', value: '2' }]
    product1 = await utils.ensureResource(ctpClient.products, productDraft1)

    const productDraft2 = utils.generateProduct(['2'], productType.id)
    productDraft2.masterVariant.attributes = [{ name: 'brandId', value: '3' }]
    product2 = await utils.ensureResource(ctpClient.products, productDraft2)
  })

  after(() =>
    utils.deleteResourcesAll(ctpClient, logger)
  )

  it('merge variants with different sameForAll attributes with blacklist',
    async () => {
      const reassignment = new VariantReassignment(['brandId'], logger, {})
      await reassignment.execute([{
        productType: {
          id: product1.productType.id
        },
        key: 'sample-product1',
        name: {
          en: 'Sample product1'
        },
        slug: {
          en: 'product'
        },
        masterVariant: {
          sku: '1',
          prices: [],
          attributes: [
            {
              name: 'brandId',
              value: '1'
            }
          ]
        },
        variants: [
          {
            sku: '2',
            prices: [],
            attributes: [
              {
                name: 'brandId',
                value: '1'
              }
            ]
          }
        ]
      }], [product1, product2])

      const { body: { results } } = await ctpClient.productProjections
        .staged(true)
        .where('masterVariant(sku in ("1", "2"))')
        .where('variants(sku in ("1", "2"))')
        .whereOperator('or')
        .fetch()
      expect(results).to.have.lengthOf(1)
      const product = results[0]
      expect(product.variants).to.have.lengthOf(1)
      expect(product.variants.attributes).to.have.lengthOf(0)
    })
})
