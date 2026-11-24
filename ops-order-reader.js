const OPS_BASE =
  'https://ops.example.invalid/admin';

function check(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function clean(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function toISODate(value) {

  const text =
    clean(value);

  if (!text) {
    return '';
  }

  const match =
    text.match(
      /^(\d{1,2})\s+([A-Za-z]{3}),\s+(\d{4})$/
    );

  if (!match) {
    return text;
  }

  const months = {
    Jan: '01',
    Feb: '02',
    Mar: '03',
    Apr: '04',
    May: '05',
    Jun: '06',
    Jul: '07',
    Aug: '08',
    Sep: '09',
    Oct: '10',
    Nov: '11',
    Dec: '12'
  };

  const day =
    match[1]
      .padStart(2, '0');

  const month =
    months[
      match[2]
    ];

  const year =
    match[3];

  if (!month) {
    return text;
  }

  return `${year}-${month}-${day}`;
}

async function verifyOpsSession(page) {

  const title =
    await page.title();

  check(
    !/admin\s*::\s*login/i.test(
      title
    ),
    'OPS session expired. Refresh ops-auth.json.'
  );
}

async function readOrderListingRow(
  page,
  orderNumber
) {

  const listURL =
    `${OPS_BASE}/order_listing.php`;

  await page.goto(
    listURL,
    {
      waitUntil:
        'domcontentloaded',
      timeout:
        30000
    }
  );

  await verifyOpsSession(
    page
  );

  const orderLink =
    page.locator(
      `a[href*="order_action.php?Action=edit_order&OrderId=${orderNumber}"]`
    ).filter({
      hasText:
        new RegExp(
          `^\\s*${orderNumber}\\s*$`
        )
    });

  await orderLink
    .first()
    .waitFor({
      state:
        'attached',
      timeout:
        15000
    });

  const row =
    orderLink
      .first()
      .locator(
        'xpath=ancestor::tr[1]'
      );

  /*
   * Actual selected OPS status.
   */
  const statusSelect =
    row.locator(
      `select[name="udata[${orderNumber}][ord_process_status]"]`
    );

  const statusValue =
    await statusSelect
      .inputValue();

  const statusText =
    clean(
      await statusSelect
        .locator(
          'option:checked'
        )
        .innerText()
    );

  /*
   * Customer detail cell.
   */
  const customerCell =
    clean(
      await row
        .locator('td')
        .nth(2)
        .innerText()
        .catch(() => '')
    );

  const customerLink =
    row.locator(
      'a[href*="user_view_details.php"]'
    ).first();

  const customerName =
    clean(
      await customerLink
        .innerText()
        .catch(() => '')
    );

  const customerHref =
    await customerLink
      .getAttribute('href');

  let userId = '';
  let corporateId = '';

  if (customerHref) {

    const customerURL =
      new URL(
        customerHref,
        listURL
      );

    userId =
      customerURL
        .searchParams
        .get('userid') || '';

    corporateId =
      customerURL
        .searchParams
        .get('corporateid') || '';
  }

  /*
   * Determine store/corporate name from:
   *
   * Example Person ( Example Company )
   *
   * or:
   *
   * Example Person
   * ( Example State Agency ... )
   */
  let store = '';

  const escapedName =
    customerName.replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&'
    );

  const storeRegex =
    new RegExp(
      `^${escapedName}\\s*\\(\\s*(.+?)\\s*\\)`
    );

  const storeMatch =
    customerCell.match(
      storeRegex
    );

  if (storeMatch) {
    store =
      clean(
        storeMatch[1]
      );
  }

  /*
   * Extract email.
   */
  const emailMatch =
    customerCell.match(
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
    );

  const email =
    emailMatch
      ? emailMatch[0]
      : '';

  return {
    orderNumber:
      String(orderNumber),

    store,

    customerName,

    email,

    userId:
      String(userId),

    corporateId:
      String(corporateId),

    opsStatus: {
      value:
        String(statusValue),
      text:
        statusText
    }
  };
}

async function readOrderProducts(
  page,
  orderNumber
) {

  const url =
    `${OPS_BASE}/order_modify.php?action=change_price&oid=${orderNumber}`;

  await page.goto(
    url,
    {
      waitUntil:
        'domcontentloaded',
      timeout:
        30000
    }
  );

  await verifyOpsSession(
    page
  );

  const orderProductInputs =
    page.locator(
      'input[name^="orderproductid_"]'
    );

  const count =
    await orderProductInputs
      .count();

  const products = [];

  for (
    let i = 0;
    i < count;
    i++
  ) {

    const orderProductId =
      await orderProductInputs
        .nth(i)
        .inputValue();

    check(
      /^\d+$/.test(
        orderProductId
      ),
      `Invalid Order Product ID on OPS Order ${orderNumber}.`
    );

    const productId =
      await page
        .locator(
          `input[name="products_type_${orderProductId}"]`
        )
        .inputValue();

    const name =
      await page
        .locator(
          `input[name="products_name_${orderProductId}"]`
        )
        .inputValue();

    const quantityText =
      await page
        .locator(
          `input[name="quantity[${orderProductId}]"]`
        )
        .inputValue();

    const orderStatus =
      await page
        .locator(
          `input[name="orderStatus_${orderProductId}"]`
        )
        .inputValue()
        .catch(() => '');

    const productionSelect =
      page.locator(
        `select[name^="ad_option[${orderProductId}]"]`
      );

    let productionOption = '';

    if (
      await productionSelect.count()
    ) {
      productionOption =
        clean(
          await productionSelect
            .first()
            .locator(
              'option:checked'
            )
            .innerText()
            .catch(() => '')
        );
    }

    const quantity =
      Number(
        String(
          quantityText
        )
          .replace(
            /,/g,
            ''
          )
      );

    check(
      Number.isFinite(quantity) &&
      quantity > 0,
      `Invalid quantity for OPS Order Product ${orderProductId}.`
    );

    products.push({
      orderProductId:
        String(
          orderProductId
        ),

      productId:
        String(
          productId
        ),

      name:
        clean(name),

      quantity,

      orderStatus:
        String(
          orderStatus
        ),

      productionOption
    });
  }

  check(
    products.length > 0,
    `No products found for OPS Order ${orderNumber}.`
  );

  return products;
}

async function readOrderDetail(
  page,
  orderNumber
) {

  const url =
    `${OPS_BASE}/order_action.php?Action=edit_order&OrderId=${orderNumber}`;

  await page.goto(
    url,
    {
      waitUntil:
        'domcontentloaded',
      timeout:
        30000
    }
  );

  await verifyOpsSession(
    page
  );

  /*
   * Customer fields.
   */
  const customerName =
    await page
      .locator(
        'input[name="customers_name"]'
      )
      .inputValue()
      .catch(() => '');

  const customerEmail =
    await page
      .locator(
        'input[name="customers_email_address"]'
      )
      .inputValue()
      .catch(() => '');

  const customerPhone =
    await page
      .locator(
        'input[name="customers_telephone"]'
      )
      .inputValue()
      .catch(() => '');

  /*
   * Due dates.
   */
  let productionDue = '';
  let orderDue = '';

  const profileRows =
    page.locator(
      '.profile-info-row'
    );

  const profileCount =
    await profileRows.count();

  for (
    let i = 0;
    i < profileCount;
    i++
  ) {

    const row =
      profileRows.nth(i);

    const label =
      clean(
        await row
          .locator(
            '.profile-info-name'
          )
          .innerText()
          .catch(() => '')
      );

    const value =
      clean(
        await row
          .locator(
            '.profile-info-value'
          )
          .innerText()
          .catch(() => '')
      );

    if (
      /production due date/i.test(
        label
      )
    ) {
      productionDue =
        toISODate(value);
    }

    if (
      /order due date/i.test(
        label
      )
    ) {
      orderDue =
        toISODate(value);
    }
  }

  /*
   * Payment & Shipping section.
   *
   * Pull the displayed label/value pairs
   * instead of depending on fixed column
   * positions.
   */
  let shippingMethod = '';
  let shippingType = '';
  let estimatedDeliveryDate = '';
  let paymentMethod = '';

  const shippingSection =
    page.locator(
      '.payment-shipping-details'
    );

  if (
    await shippingSection.count()
  ) {

    const text =
      clean(
        await shippingSection
          .innerText()
      );

    const shippingMethodMatch =
      text.match(
        /Shipping Method\s*:\s*(.+?)(?=Shipping Type\s*:|Tracking Number\s*:|Estimated Delivery Date\s*:|Billing Information|$)/i
      );

    if (
      shippingMethodMatch
    ) {
      shippingMethod =
        clean(
          shippingMethodMatch[1]
        );
    }

    const shippingTypeMatch =
      text.match(
        /Shipping Type\s*:\s*(.+?)(?=Tracking Number\s*:|Estimated Delivery Date\s*:|Billing Information|$)/i
      );

    if (
      shippingTypeMatch
    ) {
      shippingType =
        clean(
          shippingTypeMatch[1]
        );
    }

    const deliveryMatch =
      text.match(
        /Estimated Delivery Date\s*:\s*(\d{1,2}\s+[A-Za-z]{3},\s+\d{4})/i
      );

    if (
      deliveryMatch
    ) {
      estimatedDeliveryDate =
        toISODate(
          deliveryMatch[1]
        );
    }

    const paymentMatch =
      text.match(
        /Payment Method\s*:\s*(.+?)(?=Payment Date\s*:|Payment Due Date\s*:|Transaction ID\s*:|$)/i
      );

    if (
      paymentMatch
    ) {
      paymentMethod =
        clean(
          paymentMatch[1]
        );
    }
  }

  /*
   * Find the real Shipping Address edit
   * page for this order.
   */
  const shipAddressLink =
    page.locator(
      'a[href*="user_address.php"][href*="type=ship"]'
    ).first();

  check(
    await shipAddressLink.count() === 1,
    `Shipping Address link not found for OPS Order ${orderNumber}.`
  );

  const shipAddressHref =
    await shipAddressLink
      .getAttribute(
        'href'
      );

  const shipAddressURL =
    new URL(
      shipAddressHref,
      url
    ).href;

  return {
    customer: {
      name:
        clean(customerName),

      email:
        clean(customerEmail),

      phone:
        clean(customerPhone)
    },

    productionDue,

    orderDue,

    shippingMethod,

    shippingType,

    estimatedDeliveryDate,

    paymentMethod,

    shipAddressURL
  };
}

async function readShippingAddress(
  page,
  shipAddressURL
) {

  await page.goto(
    shipAddressURL,
    {
      waitUntil:
        'domcontentloaded',
      timeout:
        30000
    }
  );

  await verifyOpsSession(
    page
  );

  async function inputValue(
    name
  ) {

    const locator =
      page.locator(
        `[name="${name}"]`
      );

    if (
      await locator.count() === 0
    ) {
      return '';
    }

    return clean(
      await locator
        .first()
        .inputValue()
        .catch(() => '')
    );
  }

  const countrySelect =
    page.locator(
      'select[name="country"]'
    );

  const country =
    await countrySelect.count()
      ? clean(
          await countrySelect
            .locator(
              'option:checked'
            )
            .innerText()
            .catch(() => '')
        )
      : '';

  return {
    name:
      await inputValue(
        'firstname'
      ),

    company:
      await inputValue(
        'companyname'
      ),

    address1:
      await inputValue(
        'street_address'
      ),

    /*
     * OPS calls address line 2 "suburb".
     */
    address2:
      await inputValue(
        'suburb'
      ),

    city:
      await inputValue(
        'city'
      ),

    state:
      await inputValue(
        'state'
      ),

    zip:
      await inputValue(
        'postcode'
      ),

    country,

    countryCode:
      await inputValue(
        'country_iso_code'
      ),

    phone:
      await inputValue(
        'phone_number'
      )
  };
}

async function readOpsOrder(
  page,
  orderNumber
) {

  const listing =
    await readOrderListingRow(
      page,
      orderNumber
    );

  const detail =
    await readOrderDetail(
      page,
      orderNumber
    );

  const shipTo =
    await readShippingAddress(
      page,
      detail.shipAddressURL
    );

  const products =
    await readOrderProducts(
      page,
      orderNumber
    );

  return {
    orderNumber:
      String(
        orderNumber
      ),

    store:
      listing.store,

    opsStatus:
      listing.opsStatus,

    customer: {
      name:
        detail.customer.name ||
        listing.customerName,

      email:
        detail.customer.email ||
        listing.email,

      phone:
        detail.customer.phone
    },

    userId:
      listing.userId,

    corporateId:
      listing.corporateId,

    productionDue:
      detail.productionDue,

    orderDue:
      detail.orderDue,

    estimatedDeliveryDate:
      detail.estimatedDeliveryDate,

    shippingMethod:
      detail.shippingMethod,

    shippingType:
      detail.shippingType,

    paymentMethod:
      detail.paymentMethod,

    shipTo,

    products
  };
}

module.exports = {
  readOpsOrder,
  readOrderListingRow,
  readOrderProducts,
  readOrderDetail,
  readShippingAddress
};