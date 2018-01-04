import _ from 'lodash'
import Promise from 'bluebird'
import ProductService from '../services/product-manager'
import TransactionService from '../services/transaction-manager'

export default class VariantReassignment {

  constructor (client, logger, options = {}, blackList = [], retainExistingAttributes = []) {
    this.unfinishedTransactions = []
    this.firstRun = true
    this.customObjectService = null // build custom object service
    this.blackList = blackList
    this.options = options
    this.logger = logger
    this.retainExistingAttributes = retainExistingAttributes
    this.productService = new ProductService(logger, client)
    this.transactionService = new TransactionService(logger, client)
  }

  async execute (productDrafts, existingProductProjections) {
    this._processUnfinishedTransactions()

    const products
      = await this.productService.fetchProductsFromProductProjections(existingProductProjections)

    const productDraftsForReassignment
      = this._selectProductDraftsForReassignment(productDrafts, products)

    if (productDraftsForReassignment.length)
      for (const productDraft of productDraftsForReassignment)
        await this._processProductDraft(productDraft, products)
  }

  async _processUnfinishedTransactions () {
    if (this.firstRun)
      this.unfinishedTransactions = [] // API.getUnfinishedTransactions()

    this.firstRun = false
    for (const transaction of this.unfinishedTransactions)
      await this._createAndExecuteActions(transaction.newProductDraft,
        transaction.backupProductDraft, transaction.variants)
  }

  async _processProductDraft (productDraft, products) {
    const matchingProducts = await this._selectMatchingProducts(productDraft, products)

    if (matchingProducts.length === 0)
      return

    // select using SLUG, etc..
    const ctpProductToUpdate = this._selectCtpProductToUpdate(productDraft, matchingProducts)

    // get variants and draft to backup
    const { matchingProductsVars: backupVariants, ctpProductToUpdateVars: variantsToProcess }
      = this._getRemovedVariants(productDraft, matchingProducts, ctpProductToUpdate)
    const anonymizedProductDraft
      = this._createProductDraftWithRemovedVariants(ctpProductToUpdate, variantsToProcess)

    // create a backup object
    const transactionKey
      = await this._backupToCustomObject(productDraft, backupVariants, anonymizedProductDraft)

    await this._createAndExecuteActions(productDraft, anonymizedProductDraft, backupVariants,
      ctpProductToUpdate, transactionKey, matchingProducts)

    await this.transactionService.deleteTransaction(transactionKey)
  }

  async _createAndExecuteActions (productDraft, anonymizedProductDraft, backupVariants,
                                  ctpProductToUpdate, transactionKey, matchingProducts) {
    // load products for backupVariants -> matching products
    if (!matchingProducts) {
      matchingProducts = await this._selectMatchingProducts(productDraft)
      // load CTP product to update for backupProductDraft -> CTP product to update
      const productToUpdateCandidate
        = this._selectCtpProductToUpdate(productDraft, matchingProducts)
      if (this._isProductsSame(productToUpdateCandidate, ctpProductToUpdate))
        ctpProductToUpdate = productToUpdateCandidate
      else
      // ctpProductToUpdate has been deleted and not recreated with correct product type id
        await this._createNewProduct(ctpProductToUpdate, productDraft.productType.id)
    }

    // check if product types are the same for productDraft and CTP product to update
    if (productDraft.productType.id !== ctpProductToUpdate.productType.id) {
      await this._backupProductForProductTypeChange(transactionKey, ctpProductToUpdate)
      ctpProductToUpdate = await this._changeProductType(
        ctpProductToUpdate, productDraft.productType.id
      )
      await this._deleteBackupForProductTypeChange(transactionKey, ctpProductToUpdate)
    }
    await this._removeVariantsFromMatchingProducts(backupVariants, matchingProducts)
    // when creating variant, also ensure about sameForAll attrs - Examples 9,10,11
    ctpProductToUpdate = await this._createVariantsInCtpProductToUpdate(backupVariants,
      productDraft, ctpProductToUpdate)
    // this is done only when variants are removed from ctpProductToUpdate
    if (anonymizedProductDraft) {
      await this._removeVariantsFromCtpProductToUpdate(anonymizedProductDraft, ctpProductToUpdate)
      await this.productService.createProduct(anonymizedProductDraft)
    }
    // e.g. Example 7
    await this._ensureSlugUniqueness(productDraft, ctpProductToUpdate)
  }

  /**
   * match by variant sku - pick CTP product that has all variants
   *                        matches product draft
   * match by slug - pick CTP product that has at least one slug language
   *                        that matches product draft slug
   * match by same masterVariant sku - pick CTP product that has same master
   *                        variant as the product draft
   * take the first CTP product
   */
  _selectCtpProductToUpdate (productDraft, products) {
    const matchBySkus = this._getProductMatchByVariantSkus(productDraft, products)
    if (matchBySkus)
      return matchBySkus
    const matchBySlug = this._getProductsMatchBySlug(productDraft, products)
    if (matchBySlug.length === 1)
      return matchBySlug[0]
    const matchByMasterVariant = this._getProductsMatchByMasterVariant(productDraft, matchBySlug)
    return matchByMasterVariant || products[0]
  }

  _getProductMatchByVariantSkus (productDraft, products) {
    let matchedProduct = null
    const productDraftSkus = this.productService.getProductDraftSkus(productDraft)
    for (const product of products) {
      const productSkus = this.productService.getProductSkus(product)
      // https://lodash.com/docs/4.17.4#xor
      if (_.isEmpty(_.xor(productDraftSkus, productSkus))) {
        matchedProduct = product
        break
      }
    }
    return matchedProduct
  }

  _getProductsMatchBySlug (productDraft, products) {
    const matchedProducts = []
    const productDraftSlugs = productDraft.slug
    for (const product of products)
      for (const [lang, slug] of Object.entries(productDraftSlugs))
        if (product.masterData.staged.slug[lang] === slug) {
          matchedProducts.push(product)
          break
        }
    return matchedProducts
  }

  _getProductsMatchByMasterVariant (productDraft, products) {
    const masterVariantSku = productDraft.masterVariant.sku
    return products.find(p => p.masterData.staged.masterVariant.sku === masterVariantSku)
  }

  _saveTransaction (actions) {
    const transactionKey = '' // productId + timestamp
    const object = this.customObjectService.save({
      container: 'commercetools-sync-unprocessed-product-reassignment-actions',
      key: transactionKey,
      actions
    })

    this.unfinishedTransactions.push(object)

    return transactionKey
  }

  _selectProductDraftsForReassignment (productDrafts, ctpProducts) {
    const skuToProductMap = this._createSkuToProductMap(ctpProducts)
    return productDrafts.filter(productDraft =>
      this._isReassignmentNeeded(productDraft, skuToProductMap)
    )
  }

  _createSkuToProductMap (ctpProducts) {
    const skuToProductMap = new Map()
    ctpProducts.forEach((p) => {
      const skus = this.productService.getProductSkus(p)
      skus.forEach(sku => skuToProductMap.set(sku, p))
    })
    return skuToProductMap
  }

  /**
   * Product draft needs reassignment in these cases:
   * 1. more than 1 product matches the draft's SKUs
   * 2. or CTP product (staged or current) does not have exact SKU match with product draft
   * 3. or product type is not the same
   */
  _isReassignmentNeeded (productDraft, skuToProductMap) {
    const productSet = new Set()
    const productDraftSkus = this.productService.getProductDraftSkus(productDraft)
    productDraftSkus.forEach((sku) => {
      const product = skuToProductMap.get(sku)
      if (product)
        productSet.add(product)
    })
    if (productSet.size === 0)
    // new product from the product draft
      return false
    else if (productSet.size === 1) {
      // check if CTP product have exact SKU match with product draft
      const product = productSet.values().next().value
      const draftSkus = this.productService.getProductDraftSkus(productDraft)
      const productSkus = this.productService.getProductSkus(product)

      if (_.isEqual(draftSkus, productSkus))
        // variants are assigned correctly, maybe we need to change product type
        return product.productType.id !== productDraft.productType.id
    }
    return true
  }

  /**
   * Variants will be removed from a product for 2 reasons:
   * 1) variants will be moved to a CTP product to update from matching products
   * 2) variants needs to be removed from CTP product to update because they don't exist
   * in the new product draft anymore
   *
   * @param productDraft
   * @param matchingProducts
   * @param ctpProductToUpdate
   * @returns {{matchingProductsVariants, ctpProductToUpdateVariants}}
   * @private
   */
  _getRemovedVariants (productDraft, matchingProducts, ctpProductToUpdate) {
    const productsToRemoveVariants = matchingProducts.filter(p => p !== ctpProductToUpdate)
    const skus = this.productService.getProductDraftSkus(productDraft)

    // variants that needs to be moved from matching product
    const matchingProductsVariants = productsToRemoveVariants.map(product =>
      this._selectVariantsWithCondition(product, variant => skus.includes(variant.sku))
    )

    // variants that needs to be removed from CTP product to update
    const ctpProductToUpdateVariants = this._selectVariantsWithCondition(ctpProductToUpdate,
      variant => !skus.includes(variant.sku)
    )

    return {
      matchingProductsVars: _.flatten(matchingProductsVariants),
      ctpProductToUpdateVars: ctpProductToUpdateVariants
    }
  }

  _selectVariantsWithCondition (product, condition) {
    const skuToVariantObject = this.productService.getProductVariantsMapBySku(product)
    const variants = _.values(skuToVariantObject)
    return variants.filter(condition)
  }

  _createProductDraftWithRemovedVariants (product, variantsToBackup) {
    let productDraftClone
    if (variantsToBackup.length > 0) {
      productDraftClone = _.cloneDeep(product.masterData.staged)
      productDraftClone.key = product.key
      productDraftClone.productType = product.productType
      productDraftClone.taxCategory = product.taxCategory
      productDraftClone.state = product.state
      productDraftClone.reviewRatingStatistics = product.reviewRatingStatistics
      productDraftClone.masterVariant = variantsToBackup[0]
      productDraftClone.variants = variantsToBackup.slice(1, variantsToBackup.length)
      productDraftClone = this.productService.getAnonymizedProductDraft(productDraftClone)
    }

    return productDraftClone
  }

  _backupToCustomObject (newProductDraft, variants, backupProductDraft) {
    const transaction = {
      newProductDraft,
      variants
    }
    if (backupProductDraft)
      transaction.backupProductDraft = backupProductDraft
    return this.transactionService.createTransaction(transaction)
  }

  /**
   * Select products that has at least one variant from the productDraft.
   * @param productDraft
   * @param products
   * @returns {*}
   * @private
   */
  _selectMatchingProducts (productDraft, products) {
    const productDraftSkus = this.productService.getProductDraftSkus(productDraft)
    if (products) {
      const skuToProductMap = this._createSkuToProductMap(products)
      const matchingProducts = productDraftSkus.map(sku => skuToProductMap.get(sku))
      return _.uniq(matchingProducts)
    }
    return this.productService.getProductsBySkus(productDraftSkus)
  }

  _deleteTransaction () {
  }

  /**
   * Compare if two product objects are the same product.
   * @private
   */
  _isProductsSame () {
  }

  _createNewProduct () {
  }

  /**
   * Create a backup of a product because we need to do product type change for this product
   */
  _backupProductForProductTypeChange () {
  }

  _changeProductType () {
  }

  /**
   * Delete a backup that was created because of product type change of a product
   */
  _deleteBackupForProductTypeChange () {
  }

  /**
   * Verify that there are no other products in the platform that has slugs of productDraft
   * except ctpProductToUpdate.
   * This method should cover the test variant-reassignment-example-7.spec.js
   */
  _ensureSlugUniqueness () {
  }

  async _removeVariantsFromCtpProductToUpdate (anonymizedProductDraft, ctpProductToUpdate) {
    const skusToRemove = this.productService.getProductDraftSkus(anonymizedProductDraft)
    await this.productService.removeVariantsFromProduct(ctpProductToUpdate, skusToRemove)
  }

  async _createVariantsInCtpProductToUpdate (backupVariants, productDraft, ctpProductToUpdate) {
    const actions = []
    const skuToVariant = new Map()
    const existingSkus = this.productService.getProductSkus(ctpProductToUpdate)
    const variants = productDraft.variants || []
    variants.concat(productDraft.masterVariant).forEach((v) => {
      if (!existingSkus.includes(v.sku))
        skuToVariant.set(v.sku, v)
    })
    // preserve existing attribute data
    if (!_.isEmpty(this.retainExistingAttributes))
      backupVariants.forEach((backupVariant) => {
        const draftVariant = skuToVariant.get(backupVariant.sku)
        this.retainExistingAttributes.forEach((attrName) => {
          // https://lodash.com/docs/4.17.4#at
          const retainedAttr = _.at(backupVariant, attrName)
          if (retainedAttr.length > 0)
            draftVariant[attrName] = retainedAttr[0]
        })
      })
    // create actions
    for (const [sku, variant] of skuToVariant)
      actions.push({
        action: 'addVariant',
        sku,
        key: variant.key,
        prices: variant.prices,
        images: variant.images,
        attributes: variant.attributes
      })
    return this.productService.updateProduct(ctpProductToUpdate, actions)
  }

  async _removeVariantsFromMatchingProducts (backupVariants, matchingProducts) {
    const productToSkusToRemoveMap = new Map()
    const skuToProductMap = matchingProducts.reduce((resultMap, p) => {
      this.productService.getProductVariants(p).forEach((v) => {
        resultMap.set(v.sku, p)
      })
      return resultMap
    }, new Map())
    for (const variant of backupVariants) {
      const product = skuToProductMap.get(variant.sku)
      const actions = productToSkusToRemoveMap.get(product) || []
      actions.push(variant.sku)
      productToSkusToRemoveMap.set(product, actions)
    }

    return Promise.map(Array.from(productToSkusToRemoveMap), ([product, skus]) =>
        this.productService.removeVariantsFromProduct(product, skus),
      { concurrency: 3 })
  }

}
