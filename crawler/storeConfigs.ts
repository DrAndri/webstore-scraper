import { WebshopCrawlerOptions } from '../types/db-types.js';

export const configs: WebshopCrawlerOptions[] = [
  {
    storeId: 1,
    startUrl: 'https://ofar.is',
    type: 'crawler',
    productPageIdentifier: 'Vörulýsing',
    urlBlacklist: [
      '/blogg',
      '/frettir',
      '/um-okkur',
      '/sidan-min',
      '/afgreidslutimar-og-stadsetning',
      '/afhendingarmatar',
      '/verkstaedi',
      '/voruskil',
      '/hafa-samband',
      '/tryggingar',
      '/bokhald-og-innheimta',
      '/abendingar',
      '/vidburdir',
      '/postlisti',
      '/lausnir',
      '/fjolmidlatorg',
      '/starfstaekifaeri',
      '/leitarnidurstodur'
    ],
    selectors: {
      productPage: '#main > div',
      oldPrice:
        'div:nth-child(2) > div:nth-child(1) > div > div:nth-child(2) > div:nth-child(1) > div > div > div:nth-child(2) > p:has-text("kr.")',
      listPrice:
        'div:nth-child(2) > div:nth-child(1) > div > div:nth-child(2) > div:nth-child(1) > div > div > div:nth-child(2) > div > p:has-text("kr.")',
      name: 'div:nth-child(2) > div:nth-child(1) > div > div:nth-child(2) > div:nth-child(1) > div > div:nth-child(2) > div:nth-child(1) > h1',
      sku: 'div:nth-child(2) > div:nth-child(1) > div > div:nth-child(2) > div:nth-child(1) > div > div:nth-child(2) > div:nth-child(1) > p',
      image:
        'div:nth-child(2) > div:nth-child(1) > div > div:nth-child(1) > div:nth-child(1) > div > div:nth-child(2) > div.large-swiper > div.swiper > div > div.swiper-slide.swiper-slide-visible > div > div > div > img',
      description:
        'div:nth-child(2) > div:nth-child(1) > div > div:nth-child(1) > div:has-text("Vörulýsing") > div',
      categories: 'div:nth-child(1)',
      inStock:
        'div:nth-child(2) > div:nth-child(1) > div > div:nth-child(2) > div:nth-child(1) > div > div:has-text("Hvar er varan til?") > div > div:nth-child(1) > p',
      inStockText: 'Netverslun',
      categoryItemLocator: 'nav a',
      brand: '',
      attributes: {
        attributesTable:
          'div:nth-child(2) > div:nth-child(1) > div > div:nth-child(1) > div:nth-child(3) > div > div:nth-child(2) > div > div',
        attribute: 'div > div > div',
        attributeLabel: 'p:nth-child(1)',
        attributeValue: 'p:nth-child(2)'
      }
    }
  },
  {
    storeId: 2,
    // Moved to Odoo (/shop/...) in October 2026, the JSON-LD sku is the old Vörunúmer
    startUrl: 'https://www.tolvutek.is',
    type: 'httpcrawler',
    productPageIdentifier: '"@type": "Product"',
    // Category pages only list subcategories, products are found through the sitemap
    sitemapUrls: ['https://www.tolvutek.is/sitemap.xml'],
    urlWhitelist: ['/shop'],
    urlBlacklist: ['/shop/category', '/shop/cart', '/shop/wishlist'],
    selectors: {
      productPage: 'main',
      structuredData: { source: 'jsonld' },
      description: '#product_full_description',
      categories: '.breadcrumb',
      categoryItemLocator: 'li',
      attributes: {
        attributesTable: '#product_specifications',
        // No <tbody> in the source and the crawler's parser does not add one
        attributeGroup: 'table',
        attributeGroupName: 'tr > th',
        attribute: 'tr',
        attributeLabel: 'td:nth-child(1)',
        attributeValue: 'td:nth-child(2)'
      }
    },
    sanitizers: {
      sku: [
        {
          match: 'Vörunúmer:',
          replace: ''
        }
      ]
    }
  },
  {
    storeId: 3,
    startUrl: 'https://tl.is',
    type: 'httpcrawler',
    productPageIdentifier: '"@type":"Product"',
    urlBlacklist: [
      '/giftcard',
      '/contact',
      '/catalogsearch',
      '/greioslumatar',
      '/afhendingarmatar',
      '/verkstaedi',
      '/abyrg',
      '/vi-botartrygging',
      '/skilarettur',
      '/algengar-spurningar',
      '/innkollun',
      '/um-tolvulistann',
      '/atvinna',
      '/giftcard',
      '/styrktarsjodur',
      '/vidskiptaskilmalar',
      '/vafrakokur',
      '/netklubbur',
      '/fyrirtaekjapjonusta'
    ],
    selectors: {
      productPage:
        '#__next > div > div > div.rz-main-content-backup > div > main > div > div',
      // Price and stock are rendered client-side, so they come from JSON-LD. Its
      // availability is unreliable (OutOfStock for products in stock) and the sale
      // price is not in the HTML. JSON-LD sku is the parent of configurable products,
      // keep the variant sku from the page. JSON-LD brand is an id.
      structuredData: {
        source: 'jsonld',
        fields: { sku: false, brand: false, inStock: false, description: false }
      },
      name: '.product-details .title-content > h1',
      sku: '.product-details .title-content > p',
      image: '.section-gallery .image-large-display img',
      description: '.detail-desc div.rz-magento-html',
      categories: '.page-breadcrumb > ul',
      categoryItemLocator: 'li',
      attributes: {
        attributesTable:
          '.page-section-left-wrapper .detail-spec > .section-content',
        attribute: '.product-spec-group > div',
        attributeLabel: '.product-spec-label > p',
        attributeValue: '.product-spec-content > p',
        attributeGroup: 'div:has(> .product-spec-group-label)',
        attributeGroupName: '.product-spec-group-label > p'
      }
    }
  },
  {
    storeId: 4,
    startUrl: 'https://elko.is',
    type: 'httpcrawler',
    // isProductPage is also in the page data of category pages
    productPageIdentifier: '"@type":"Product"',
    urlWhitelist: ['/vorur', '/voruflokkar'],
    selectors: {
      productPage: 'main > div',
      structuredData: {
        source: 'jsonld',
        fields: { categories: 'breadcrumbs' }
      },
      // First div is the price, the second holds the old price when on sale
      oldPrice: '.notDutyFree > div:nth-child(2) > span',
      attributes: {
        attributesTable: 'dl',
        attribute: 'div',
        attributeLabel: 'dt',
        attributeValue: 'dd'
      }
    }
  },
  {
    storeId: 5,
    startUrl: 'https://computer.is',
    type: 'httpcrawler',
    productPageIdentifier: 'class="single-product"',
    urlWhitelist: ['/is/product'],
    selectors: {
      productPage: '#cartdivcontent',
      oldPrice: '.pantavoru .olderPrice',
      listPrice: '.pantavoru .displayPrice',
      name: '.single-product > h2',
      sku: '.pantavoru > div:nth-child(4)',
      image: '.productImg img.mainimg',
      imageAttribute: 'data-src',
      description: '.product-desc > .tab-content',
      categories: '.breadcrumb',
      inStock: '.status',
      inStockText: 'Til á lager',
      categoryItemLocator: 'li',
      brand: '.pantavoru > .extraInfo:nth-child(3) > a',
      attributes: {
        attributesTable: '.col-sm-6',
        attribute: 'tr',
        attributeLabel: 'td:nth-child(1)',
        attributeValue: 'td:nth-child(2)',
        attributeGroup: 'table.spectable',
        attributeGroupName: 'th'
      }
    },
    sanitizers: {
      sku: [
        {
          match: 'Framl.númer:',
          replace: ''
        }
      ]
    }
  },
  {
    storeId: 7,
    startUrl: 'https://kd.is/',
    type: 'crawler',
    productPageIdentifier: 'Vörulýsing',
    urlWhitelist: ['/category'],
    selectors: {
      productPage: 'div.product',
      oldPrice: 'header > .title > h4',
      listPrice: 'header > .title h3',
      name: 'h1',
      sku: 'h5',
      description: '.description',
      attributes: {
        attributesTable: 'table',
        attribute: 'tr',
        attributeLabel: 'td:nth-child(1)',
        attributeValue: 'td:nth-child(2)'
      }
    },
    sanitizers: {
      sku: [
        {
          match: 'Vörunúmer:',
          replace: ''
        }
      ]
    }
  },
  {
    storeId: 8,
    startUrl: 'https://ht.is',
    type: 'httpcrawler',
    productPageIdentifier: '"@type":"Product"',
    urlBlacklist: [
      '/giftcard',
      '/contact',
      '/catalogsearch',
      '/greioslumatar',
      '/afhendingarmatar',
      '/verkstaedi',
      '/abyrg',
      '/vidbotartrygging',
      '/skilarettur',
      '/algengar-spurningar',
      '/innkollun',
      '/um-heimilistaeki',
      '/atvinna',
      '/giftcard',
      '/autostore',
      '/styrktarsjodur',
      '/vidskiptaskilmalar',
      '/vafrakokur',
      '/opnunartimi',
      '/jafnlaunastefna',
      '/jafnrettisaaetlun'
    ],
    selectors: {
      productPage: '#__next > div > div > div.rz-main-content-backup',
      // Same platform as tl.is, see the notes there
      structuredData: {
        source: 'jsonld',
        fields: { sku: false, brand: false, inStock: false, description: false }
      },
      name: '.product-details .title-content > h1',
      sku: '.product-details .title-content > p',
      image: '.section-gallery .image-large-display .rz-image-view img',
      description:
        '.page-section-left-wrapper .page-details-section .product-detail-section.detail-desc > div.section-content .rz-magento-html',
      categories: '.page-breadcrumb ul',
      categoryItemLocator: 'p',
      brand: '',
      attributes: {
        attributesTable:
          '.page-section-left-wrapper .detail-spec > .section-content',
        attribute: '.product-spec-group > div',
        attributeLabel: '.product-spec-label > p',
        attributeValue: '.product-spec-content > p',
        attributeGroup: 'div:has(> .product-spec-group-label)',
        attributeGroupName: '.product-spec-group-label'
      }
    }
  },
  {
    storeId: 9,
    startUrl: 'https://vefverslun.ok.is/',
    type: 'httpcrawler',
    productPageIdentifier: 'swift_products-details-images-modal',
    urlBlacklist: ['/vidskiptaskilmalar', '/cart', '/skra-inn', '/vorur'],
    selectors: {
      productPage: '#content',
      oldPrice: '.item_description__short__custom strong',
      listPrice:
        '.item_swift_productprice_productdetailpage_custom .text-price',
      name: 'h1.item_swift_productheader',
      sku: 'div.item_swift_productnumber',
      image:
        '.item_swift_productdetailsimage .carousel .carousel-item.active img',
      description:
        '.item_swift_productlongdescription > div > div:nth-child(2)',
      // The breadcrumb only holds "Vörur" and the product name, categories are only in the JS menu
      inStock: '.item_swift_productaddtocart_custom .js-add-to-cart-button',
      inStockText: 'Bæta í körfu'
    }
  },
  {
    storeId: 10,
    startUrl: 'https://epli.is',
    type: 'httpcrawler',
    productPageIdentifier: 'product-layout',
    urlBlacklist: [
      '/uppitaka',
      '/um-okkur',
      '/thjonustuvefur',
      '/epliogumhverfid',
      '/minar-sidur',
      '/hafdu-samband',
      '/leit'
    ],
    selectors: {
      productPage: '.main',
      oldPrice: '#product-prices > p.product-info__price--old',
      listPrice: '#product-prices > p:last-child',
      name: '#product-title',
      sku: '#product-sku',
      image: '#product-image .product-images-slider__image img',
      description: '#product-description',
      categories: '.breadcrumbs',
      categoryItemLocator: 'a'
    }
  },

  {
    storeId: 11,
    startUrl: 'https://kronan.is',
    type: 'httpcrawler',
    productPageIdentifier: '"@type":"Product"',
    urlWhitelist: ['/vara', '/voruurval'],
    selectors: {
      productPage: 'main',
      structuredData: { source: 'jsonld', fields: { categories: 'category' } }
    }
  },
  {
    storeId: 12,
    startUrl: 'https://hagkaup.is',
    type: 'httpcrawler',
    productPageIdentifier: '"@type":"Product"',
    urlBlacklist: [
      '/opnunartimi',
      '/um-okkur',
      '/grein',
      '/jafnlaunastefna',
      '/skilmalar',
      '/starfsmannamal',
      '/skrifstofa',
      '/afhendingarmoguleikar',
      '/skilareglur',
      '/algengar-spurningar',
      '/veislurettir-spurningar',
      '/vidskiptakort',
      '/gjafakort',
      '/leit'
    ],
    selectors: {
      productPage: '#main-content',
      // category is "Snyrtivara|Förðun|Varir|Varalitir"
      structuredData: {
        source: 'jsonld',
        fields: { categories: 'category' },
        categorySplitter: '|'
      },
      oldPrice: '',
      listPrice: 'p:contains("Verð")',
      name: 'div > div > p.font-serif',
      sku: 'p:contains("Vörunúmer:")',
      image: '.w-full img',
      description: '#accordion__panel-0',
      categories: 'div:nth-child(1)',
      inStock: 'button.uppercase',
      inStockText: 'Setja í körfu',
      categoryItemLocator: 'a',
      brand: 'div > div > a > p'
    },
    sanitizers: {
      sku: [
        {
          match: 'Vörunúmer:',
          replace: ''
        },
        {
          // JSON-LD sku is HAG_1256317
          match: 'HAG_',
          replace: ''
        }
      ]
    }
  },
  {
    storeId: 13,
    startUrl: 'https://nexus.is',
    type: 'httpcrawler',
    productPageIdentifier: 'product-gallery',
    urlWhitelist: ['/voruflokkur', '/vara'],
    selectors: {
      productPage: '.product-container',
      oldPrice: '',
      listPrice: '.product-page-price > .amount',
      name: 'h1.product-title',
      sku: '.sku_wrapper > .sku',
      image: '.wp-post-image',
      description: '.product-page-sections div:nth-child(1) .panel',
      categories: '.breadcrumbs',
      inStock: '.stock',
      inStockText: 'Á lager',
      categoryItemLocator: 'a',
      brand: 'span.tagged_as:contains("Vörumerki:") > a:nth-child(1)'
    }
  },
  {
    storeId: 14,
    startUrl: 'https://vefverslun.advania.is',
    type: 'crawler',
    productPageIdentifier: 'Almennar upplýsingar',
    urlWhitelist: ['/voruflokkar'],
    menuClicker: 'span:has-text("Vöruflokkar")',
    selectors: {
      productPage: '.product-details__wrapper',
      oldPrice: '',
      listPrice: 'p.text-price',
      name: 'h1.details__product-name',
      sku: '.details > div:nth-child(1)',
      image: '.image-carousel ol > li:nth-child(1) > img',
      description: '.details__description',
      // The breadcrumb only holds "Vöruflokkar" and the product name
      inStock: '.detail__actions',
      inStockText: 'Bæta í körfu',
      attributes: {
        attributesTable: '#info-tabs .tabs__panel > div',
        attribute: 'div > div',
        attributeLabel: 'p',
        attributeValue: 'div',
        attributeGroup: 'div',
        attributeGroupName: 'h4'
      }
    }
  },
  {
    storeId: 15,
    startUrl: 'https://www.bauhaus.is',
    type: 'httpcrawler',
    productPageIdentifier: '"@type":"Product"',
    urlBlacklist: [
      '/afgreidslutimar',
      '/fyrirtaekjasvid-bauhaus',
      '/fs',
      '/thjonusta',
      '/kataloger',
      '/skila-og-skipta',
      '/vefverslun',
      '/sitereview',
      '/gjafakort',
      '/verdoryggi',
      '/hafdu-samband',
      '/her-er-BAUHAUS',
      '/upplysingar',
      '/postlisti',
      '/skilmalar',
      '/atvinna-i-bauhaus',
      '/gildin-okkar',
      '/jafnlaunastefna',
      '/leikjaskilyrdi',
      '/um-okkur',
      '/umhverfisstefna',
      '/gagnavernd',
      '/bauhaus-styrkveitingar',
      '/cookie-policy'
    ],
    selectors: {
      // #main-content is empty in the server rendered html
      productPage: 'body',
      // Products used to be keyed by the barcode (Strikamerki), which is the gtin
      structuredData: { source: 'jsonld', fields: { sku: 'gtin' } },
      categories: 'ul[data-testid="breadcrumbs"]',
      categoryItemLocator: 'li',
      attributes: {
        attributesTable: 'table.table-auto',
        attribute: 'tr',
        attributeLabel: 'td:nth-child(1)',
        attributeValue: 'td:nth-child(2)'
      }
    }
  },
  {
    storeId: 16,
    startUrl: 'https://byko.is',
    type: 'httpcrawler',
    productPageIdentifier: 'id="product-ean-numbers"',
    urlWhitelist: ['/vara', '/voruflokkar'],
    selectors: {
      productPage: '#wrapper',
      structuredData: {
        source: 'nextdata',
        fields: {
          price: 'props.pageProps.product.variants.0.price.gross',
          name: 'props.pageProps.product.name',
          brand: 'props.pageProps.product.attributes.brand',
          image: [
            'props.pageProps.product.variants.0.firstImage.image.productGallery',
            'props.pageProps.product.firstImage.image.productGallery'
          ],
          description: 'props.pageProps.product.description.is',
          inStock: 'props.pageProps.product.webstoreInStock',
          categories: 'props.pageProps.breadCrumbs'
        }
      },
      oldPrice:
        'div:nth-child(2) div:nth-child(2) div:contains("VERÐ ÁÐUR") > div:nth-child(1) > div:nth-child(2) > span',
      sku: 'p:contains("VNR.")'
    },
    sanitizers: {
      sku: [
        {
          match: 'VNR.',
          replace: ''
        }
      ]
    }
  },
  {
    storeId: 17,
    startUrl: 'https://vefverslun.siminn.is',
    type: 'httpcrawler',
    productPageIdentifier: 'productsimple',
    urlBlacklist: [
      '/en',
      '/is/filterSearch',
      '/is/compareproducts',
      '/is/wishlist',
      '/is/register',
      '/is/login',
      '/is/cart',
      '/startpakkinn-2'
    ],
    selectors: {
      productPage:
        '#product-details-form > div.productsimple > div:nth-child(1) > div.product-essential.varacontainer',
      listPrice: '.product-price > p',
      name: 'h1.varaheading',
      // The visible sku span is filled in by JS, its id holds the product id (sku-1278)
      sku: {
        source: 'attribute',
        selector: 'span.vara-sku[id^="sku-"]',
        attribute: 'id'
      },
      image: '.picture-gallery > .picture > img',
      description: '.short-description',
      categories: '.breadcrumb',
      inStock: '.lagerstadawrap',
      inStockText: 'Til á lager',
      categoryItemLocator: 'ul > li > a > span',
      brand: 'div.vara-sku > span:nth-child(1)'
    },
    sanitizers: {
      sku: [
        {
          match: 'sku-',
          replace: ''
        }
      ]
    }
  },
  {
    storeId: 18,
    startUrl: 'https://utilif.is',
    type: 'httpcrawler',
    productPageIdentifier: 'BaseProductPageLayoutWrapper',
    urlBlacklist: [
      '/customer',
      '/cart',
      '/blog-list',
      '/TNF-algengarSpurningar',
      '/verslanir',
      '/jardsambandid_skraning',
      '/gjafakort',
      '/verkstaedi',
      '/thjonusta',
      '/algengarspurningar',
      '/umutilif',
      '/starfsumsokn',
      '/vafrakokur',
      '/skilmalar',
      '/personuverndarstefna',
      '/catalogsearch'
    ],
    selectors: {
      productPage: 'div.rz-main-content-backup > div > main > div > div',
      // Same platform as tl.is. The gallery is rendered client-side, only the image is
      // taken from JSON-LD, its sku is the parent of the variant on the page.
      structuredData: {
        source: 'jsonld',
        fields: {
          sku: false,
          name: false,
          brand: false,
          price: false,
          inStock: false
        }
      },
      listPrice: '.section-price > h4',
      name: '.title-content > h1',
      sku: '.title-content > p',
      description: '.detail-desc div.rz-magento-html',
      categories: '.page-breadcrumb > ul',
      inStock: '.stocks-delivery-wrapper',
      inStockText: 'Til á lager',
      categoryItemLocator: 'li > a > p',
      brand: '.brand-wrapper > a > p'
    }
  },
  {
    storeId: 19,
    startUrl: 'https://hverslun.is',
    type: 'httpcrawler',
    productPageIdentifier: '"@type": "Product"',
    urlBlacklist: [
      '/build-hverslun',
      '/um-okkur',
      '/innskraning',
      '/minar-sidur',
      '/gjafabref',
      '/h-klubburinn',
      '/skilmalar',
      '/personuverndarstefna',
      '/leit',
      '/gefdu-gjafabref-sem-gledur-og-hvetur'
    ],
    selectors: {
      productPage: '#main',
      // The price on the page is filled in by JS, JSON-LD has the price, sku and name.
      // Stock and sale price are not in the html.
      structuredData: { source: 'jsonld' },
      sku: '.product-page-details__sku--desktop',
      brand: '.product-page-details__brand',
      image: '.product-page-image-slider__image',
      description: '.product-description__text',
      categories: '.breadcrumbs-desktop',
      categoryItemLocator: 'a'
    },
    sanitizers: {
      sku: [
        {
          match: 'Vnr.',
          replace: ''
        }
      ]
    }
  },
  {
    storeId: 20,
    startUrl: 'https://ikea.is',
    type: 'httpcrawler',
    productPageIdentifier: '"@type": "Product"',
    urlWhitelist: ['/is/products'],
    selectors: {
      // The package info (#collapsePackageWeight) is outside .contentWrapper-container
      productPage: 'body',
      // mpn is the article number (195.281.67), brand holds the product type
      structuredData: {
        source: 'jsonld',
        fields: { sku: 'mpn', brand: false }
      },
      oldPrice: '.itemOldPrice > .oldValue > .price__integer',
      listPrice: '.price > span > .price__integer',
      sku: '.productNumber',
      image: '#react-product-gallery > div:nth-child(1) img',
      description: '.custom-benefit-resume-container',
      categories: 'ol.breadcrumb',
      inStock: '.stock-wrapper',
      inStockText: 'Til á lager',
      categoryItemLocator: 'a',
      attributes: {
        attributesTable: '#collapsePackageWeight',
        attribute: 'tr',
        attributeLabel: 'td:nth-child(1)',
        attributeValue: 'td:nth-child(2)'
      }
    }
  },
  {
    storeId: 21,
    startUrl: 'https://www.vinbudin.is',
    type: 'httpcrawler',
    productPageIdentifier: 'Varan fæst í eftirfarandi Vínbúðum',
    urlWhitelist: ['/heim/vorur', '/desktopdefault.aspx/tabid-54'],
    selectors: {
      productPage: '#wrapper > .content',
      listPrice: '.price > .money',
      name: 'h3.title > span:nth-child(1)',
      sku: 'h3.title > .product-number-text',
      image: '#first_image',
      description: '.category-description-text .entire-text',
      categories: '#breadcrumbs > ul',
      inStock: '#cart-link',
      inStockText: 'Setja í körfu',
      categoryItemLocator: 'li > a',
      brand: '#ctl00_ctl01_Label_Producer',
      attributes: {
        attributesTable: '.product-packaging-info',
        attribute: 'div',
        attributeLabel: 'span.title',
        attributeValue: 'span.value'
      }
    },
    sanitizers: {
      sku: [
        {
          match: '(',
          replace: ''
        },
        {
          match: ')',
          replace: ''
        }
      ]
    }
  }
];
