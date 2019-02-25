import { expect } from 'chai'
import VariantReassignment from '../../../lib/runner/variant-reassignment'
import * as utils from '../../utils/helper'
import { PRODUCT_ANONYMIZE_SLUG_KEY } from '../../../lib/constants'

/* eslint-disable max-len */
/**
 * +-----------------------------------------+-------------------------+--------------------+-------------------------------------------------------------+
 * | New product draft                       | CTP product             | After reassignment | CTP product                                                 |
 * +-----------------------------------------+-------------------------+                    +-------------------------------------------------------------+
 * | Product:                                | Product:                |                    | Product:                                                    |
 * | slug: { en: "product", de: "produkte" } | id: "1"                 |                    | id: "1"                                                     |
 * | product-type: "pt1"                     | slug: { en: "product" } |                    | slug: { en: "product" }                                     |
 * | variants: v1                            | product-type: "pt1"     |                    | product-type: "pt1"                                         |
 * |                                         | variants: v1, v2, v3    |                    | variants: v1                                                |
 * +-----------------------------------------+-------------------------+                    +-------------------------------------------------------------+
 * |                                         |                         |                    | Product:                                                    |
 * |                                         |                         |                    | id: "2"                                                     |
 * |                                         |                         |                    | key: key + "-duplicate"                                     |
 * |                                         |                         |                    | slug: { en: "product_${timestamp}", ctsd: "${timestamp}" }  |
 * |                                         |                         |                    | product-type: "pt1"                                         |
 * |                                         |                         |                    | variants: v2, v3                                            |
 * +-----------------------------------------+-------------------------+--------------------+-------------------------------------------------------------+
 */
/* eslint-enable max-len */
describe('Variant reassignment - removing variants', () => {
  const logger = utils.createLogger(__filename)
  let ctpClient
  let product1

  before(async () => {
    ctpClient = await utils.createClient()
    const results = await utils.createCtpProducts([['1', '2', '3']], ctpClient)
    product1 = results.find(product => product.masterVariant.sku === '1')
  })

  after(() =>
    utils.deleteResourcesAll(ctpClient, logger)
  )

  it('remove variants v2 and v3 from product 1', async () => {
    const reassignment = new VariantReassignment(ctpClient, logger)
    const { statistics } = await reassignment.execute([{
      productType: {
        id: product1.productType.id
      },
      name: {
        en: 'Sample product1'
      },
      slug: {
        en: 'sample-product1'
      },
      masterVariant: {
        sku: '1',
      },
      variants: []
    }])

    utils.expectStatistics(statistics, 1, 0, 1, 1)
    const { body: { results } } = await utils.getProductsBySkus(['1', '2', '3'], ctpClient)
    expect(results).to.have.lengthOf(2)
    const updatedProduct = results.find(product => product.masterVariant.sku === '1')
    expect(updatedProduct).to.be.an('object')
    expect(updatedProduct.variants).to.have.lengthOf(0)

    const newProduct = results.find(product => product.masterVariant.sku !== '1')
    expect(newProduct.variants).to.have.lengthOf(1)
    expect(newProduct.slug[PRODUCT_ANONYMIZE_SLUG_KEY]).to.be.a('string')
  })
})
