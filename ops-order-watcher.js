require('dotenv').config();

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ORDER_LIST_URL =
  'https://ops.example.invalid/admin/order_listing.php';

const STATE_DIR =
  path.join(
    __dirname,
    'integration-state'
  );

const WATCHER_STATE_FILE =
  path.join(
    STATE_DIR,
    'ops-watcher.json'
  );

const OPS_AUTH_FILE =
  path.join(
    __dirname,
    'ops-auth.json'
  );

function check(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function loadWatcherState() {

  if (
    !fs.existsSync(
      WATCHER_STATE_FILE
    )
  ) {
    return {
      version: 1,
      initialized: false,
      initializedAt: null,
      lastCheckedAt: null,
      highestOrderSeen: null,
      knownOrders: {},
      discoveredOrders: {}
    };
  }

  return JSON.parse(
    fs.readFileSync(
      WATCHER_STATE_FILE,
      'utf8'
    )
  );
}

function saveWatcherState(state) {

  fs.mkdirSync(
    STATE_DIR,
    {
      recursive: true
    }
  );

  const temp =
    `${WATCHER_STATE_FILE}.tmp`;

  fs.writeFileSync(
    temp,
    JSON.stringify(
      state,
      null,
      2
    )
  );

  fs.renameSync(
    temp,
    WATCHER_STATE_FILE
  );
}

async function discoverOrders(page) {

  await page.goto(
    ORDER_LIST_URL,
    {
      waitUntil:
        'domcontentloaded',

      timeout:
        30000
    }
  );

  const title =
    await page.title();

  check(
    !/admin\s*::\s*login/i.test(
      title
    ),
    'OPS session expired. Refresh ops-auth.json.'
  );

  const orderLinkSelector =
    'a[href*="order_action.php?Action=edit_order&OrderId="]';

  await page
    .locator(orderLinkSelector)
    .first()
    .waitFor({
      state: 'attached',
      timeout: 15000
    });

  const orderAnchors =
    page.locator(
      'a[href*="order_action.php?Action=edit_order&OrderId="]'
    );

  const count =
    await orderAnchors.count();

  const orders = [];
  const seen = new Set();

  for (
    let i = 0;
    i < count;
    i++
  ) {

    const anchor =
      orderAnchors.nth(i);

    const text =
      (
        await anchor
          .innerText()
          .catch(() => '')
      )
        .trim();

    if (
      !/^\d+$/.test(
        text
      )
    ) {
      continue;
    }

    const orderNumber =
      text;

    if (
      seen.has(
        orderNumber
      )
    ) {
      continue;
    }

    seen.add(
      orderNumber
    );

    const row =
      anchor.locator(
        'xpath=ancestor::tr[1]'
      );

    /*
     * Customer
     */
    const customer =
      await row
        .locator(
          'a[href*="user_view_details.php"]'
        )
        .first()
        .innerText()
        .catch(() => '');

    /*
     * Full row text.
     */
    const rowText =
      (
        await row
          .innerText()
          .catch(() => '')
      )
        .replace(
          /\s+/g,
          ' '
        )
        .trim();

    /*
     * Actual selected order status.
     */
    const statusSelect =
      row.locator(
        'select[name*="[ord_process_status]"]'
      );

    let statusValue = '';
    let statusText = '';

    if (
      await statusSelect.count()
    ) {

      statusValue =
        await statusSelect
          .first()
          .inputValue()
          .catch(() => '');

      statusText =
        (
          await statusSelect
            .first()
            .locator(
              'option:checked'
            )
            .innerText()
            .catch(() => '')
        )
          .trim();
    }

    /*
     * Modify URL
     */
    const modifyURL =
      await row
        .locator(
          `a[href*="order_modify.php"][href*="oid=${orderNumber}"]`
        )
        .first()
        .getAttribute(
          'href'
        )
        .catch(() => null);

    /*
     * Download File URL
     */
    const downloadURL =
      await row
        .locator(
          `a[href*="action=downloadorder"][href*="OrderId=${orderNumber}"]`
        )
        .first()
        .getAttribute(
          'href'
        )
        .catch(() => null);

    /*
     * Job Ticket URL
     */
    const jobTicketURL =
      await row
        .locator(
          `a[href*="order_print_job_ticket.php"][href*="OrderId=${orderNumber}"]`
        )
        .first()
        .getAttribute(
          'href'
        )
        .catch(() => null);

    orders.push({
      orderNumber:
        String(
          orderNumber
        ),

      customer:
        customer.trim(),

      statusValue:
        String(
          statusValue
        ),

      statusText,

      rowText,

      modifyURL,

      downloadURL,

      jobTicketURL
    });
  }

  orders.sort(
    (a, b) =>
      Number(
        b.orderNumber
      ) -
      Number(
        a.orderNumber
      )
  );

  return orders;
}

(async () => {

  let browser;

  try {

    console.log('');
    console.log(
      '========================================'
    );

    console.log(
      'OPS ORDER WATCHER'
    );

    console.log(
      'OBSERVE ONLY - NO PROCESSING'
    );

    console.log(
      '========================================'
    );

    check(
      fs.existsSync(
        OPS_AUTH_FILE
      ),
      'ops-auth.json is missing.'
    );

    const state =
      loadWatcherState();

    browser =
      await chromium.launch({
        headless: false
      });

    const context =
      await browser.newContext({
        storageState:
          OPS_AUTH_FILE
      });

    const page =
      await context.newPage();

    /*
     * Only allow the DataTables POST
     * used to READ the order listing.
     *
     * Block all other POST requests.
     */
    await page.route(
      '**/*',
      async route => {

        const request =
          route.request();

        if (
          request.method() !==
          'POST'
        ) {
          await route.continue();
          return;
        }

        const url =
          new URL(
            request.url()
          );

        const isListingRead =
          url.origin ===
            'https://ops.example.invalid' &&
          url.pathname ===
            '/admin/order_listing.php';

        if (
          isListingRead
        ) {
          await route.continue();
          return;
        }

        console.log('');
        console.log(
          'BLOCKED UNEXPECTED POST:'
        );

        console.log(
          request.url()
        );

        await route.abort();
      }
    );

    const orders =
      await discoverOrders(
        page
      );

    check(
      orders.length > 0,
      'No OPS orders were discovered.'
    );

    console.log('');
    console.log(
      'Orders visible:',
      orders.length
    );

    console.log(
      'Highest order:',
      orders[0].orderNumber
    );

    const now =
      new Date()
        .toISOString();

    /*
     * ======================================
     * FIRST RUN
     * ESTABLISH BASELINE
     * ======================================
     */
    if (
      !state.initialized
    ) {

      console.log('');
      console.log(
        'FIRST WATCHER RUN'
      );

      console.log(
        'Establishing current OPS orders as baseline.'
      );

      for (
        const order of
        orders
      ) {

        state.knownOrders[
          order.orderNumber
        ] = {
          firstSeenAt:
            now,

          baseline:
            true,

          customer:
            order.customer,

          statusValue:
            order.statusValue,

          statusText:
            order.statusText
        };
      }

      state.initialized =
        true;

      state.initializedAt =
        now;

      state.lastCheckedAt =
        now;

      state.highestOrderSeen =
        orders[0]
          .orderNumber;

      saveWatcherState(
        state
      );

      console.log('');
      console.log(
        '========================================'
      );

      console.log(
        'WATCHER BASELINE CREATED'
      );

      console.log(
        '========================================'
      );

      console.log(
        `Highest existing OPS Order: ${state.highestOrderSeen}`
      );

      console.log(
        `Baseline Orders: ${orders.length}`
      );

      console.log('');
      console.log(
        'No existing order was marked for processing.'
      );

      console.log(
        'No Pace data was changed.'
      );

      console.log(
        '========================================'
      );

      return;
    }

    /*
     * ======================================
     * FIND NEW ORDERS
     * ======================================
     */
    const newOrders =
      orders.filter(
        order =>
          !state.knownOrders[
            order.orderNumber
          ]
      );

    console.log('');
    console.log(
      'New orders detected:',
      newOrders.length
    );

    /*
     * Process oldest new ID first so if
     * several arrive between runs, their
     * discovery order remains sensible.
     */
    newOrders.sort(
      (a, b) =>
        Number(
          a.orderNumber
        ) -
        Number(
          b.orderNumber
        )
    );

    for (
      const order of
      newOrders
    ) {

      console.log('');
      console.log(
        '========================================'
      );

      console.log(
        'NEW OPS ORDER DETECTED'
      );

      console.log(
        '========================================'
      );

      console.log(
        'Order:',
        order.orderNumber
      );

      console.log(
        'Customer:',
        order.customer
      );

      console.log(
        'OPS Status:',
        order.statusText
      );

      console.log(
        'Status Value:',
        order.statusValue
      );

      console.log(
        'Modify URL:',
        order.modifyURL
      );

      console.log(
        'Download URL:',
        order.downloadURL
      );

      /*
       * IMPORTANT:
       *
       * Discovery does NOT mean processed.
       *
       * This record will later become input
       * to the production eligibility queue.
       */
      state.discoveredOrders[
        order.orderNumber
      ] = {
        discoveredAt:
          now,

        status:
          'discovered',

        customer:
          order.customer,

        opsStatusValue:
          order.statusValue,

        opsStatusText:
          order.statusText,

        modifyURL:
          order.modifyURL,

        downloadURL:
          order.downloadURL,

        jobTicketURL:
          order.jobTicketURL
      };

      state.knownOrders[
        order.orderNumber
      ] = {
        firstSeenAt:
          now,

        baseline:
          false,

        customer:
          order.customer,

        statusValue:
          order.statusValue,

        statusText:
          order.statusText
      };
    }

    /*
     * Refresh current status for every
     * visible order we already know.
     */
    for (
      const order of
      orders
    ) {

      if (
        !state.knownOrders[
          order.orderNumber
        ]
      ) {
        continue;
      }

      state.knownOrders[
        order.orderNumber
      ].lastSeenAt =
        now;

      state.knownOrders[
        order.orderNumber
      ].statusValue =
        order.statusValue;

      state.knownOrders[
        order.orderNumber
      ].statusText =
        order.statusText;
    }

    state.lastCheckedAt =
      now;

    const highest =
      orders.reduce(
        (max, order) =>
          Math.max(
            max,
            Number(
              order.orderNumber
            )
          ),
        0
      );

    if (
      !state.highestOrderSeen ||
      highest >
        Number(
          state.highestOrderSeen
        )
    ) {
      state.highestOrderSeen =
        String(
          highest
        );
    }

    saveWatcherState(
      state
    );

    console.log('');
    console.log(
      '========================================'
    );

    console.log(
      'WATCHER CHECK COMPLETE'
    );

    console.log(
      '========================================'
    );

    console.log(
      'Highest order seen:',
      state.highestOrderSeen
    );

    console.log(
      'New orders:',
      newOrders.length
    );

    console.log(
      'No Pace jobs were created.'
    );

    console.log(
      'No OPS data was changed.'
    );

    console.log(
      '========================================'
    );

  } catch (
    error
  ) {

    console.log('');
    console.log(
      '========================================'
    );

    console.log(
      'OPS WATCHER STOPPED'
    );

    console.log(
      '========================================'
    );

    console.log(
      error.message
    );

    process.exitCode = 1;

  } finally {

    if (browser) {
      await browser.close();
    }

  }

})();