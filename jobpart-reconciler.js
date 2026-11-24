const fs = require('fs');
const path = require('path');

const DEFAULT_BASE =
  'https://pace.example.invalid/epace/company:public';

function clean(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeQuantity(value) {

  return String(
    value == null
      ? ''
      : value
  )
    .replace(/,/g, '')
    .replace(/\s+/g, '')
    .trim();
}

function escapeRegex(value) {
  return String(value)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeBody(body) {

  try {
    return decodeURIComponent(
      String(body || '')
        .replace(/\+/g, ' ')
    );
  } catch {
    return String(body || '');
  }
}

function loadJSON(file, fallback) {

  if (!fs.existsSync(file)) {
    return fallback;
  }

  return JSON.parse(
    fs.readFileSync(
      file,
      'utf8'
    )
  );
}

function saveJSONAtomic(file, data) {

  fs.mkdirSync(
    path.dirname(file),
    {
      recursive: true
    }
  );

  const temp =
    `${file}.tmp`;

  fs.writeFileSync(
    temp,
    JSON.stringify(
      data,
      null,
      2
    )
  );

  fs.renameSync(
    temp,
    file
  );
}

function createJobPartReconciler({
  page,
  paceJobNumber,
  orderNumber,
  stateDir =
    path.join(
      __dirname,
      'integration-state'
    ),
  base = DEFAULT_BASE,
  allowWrites = false
}) {

  if (!page) {
    throw new Error(
      'page is required.'
    );
  }

  paceJobNumber =
    String(
      paceJobNumber
    ).trim();

  orderNumber =
    String(
      orderNumber
    ).trim();

  if (!paceJobNumber) {
    throw new Error(
      'paceJobNumber is required.'
    );
  }

  if (!orderNumber) {
    throw new Error(
      'orderNumber is required.'
    );
  }

  const stateFile =
    path.join(
      stateDir,
      `ops-${orderNumber}-parts.json`
    );

  let allowedWrite = null;
  let firewallInstalled = false;

  const pendingDuplicateFile =
    path.join(
      stateDir,
      `ops-${orderNumber}-parts-pending.json`
    );

  function getPendingDuplicate() {

    if (
      !fs.existsSync(
        pendingDuplicateFile
      )
    ) {
      return null;
    }

    return JSON.parse(
      fs.readFileSync(
        pendingDuplicateFile,
        'utf8'
      )
    );
  }

  function recordPendingDuplicate({
    orderProductId,
    estimatePart,
    sourcePart,
    partsBefore
  }) {

    const existing =
      getPendingDuplicate();

    if (existing) {
      throw new Error(
        `JOBPART RECOVERY REQUIRED: unresolved duplicate operation already exists: ` +
        `${JSON.stringify(existing)}`
      );
    }

    saveJSONAtomic(
      pendingDuplicateFile,
      {
        status:
          'duplicate_pending',

        orderNumber:
          String(orderNumber),

        paceJob:
          String(paceJobNumber),

        orderProductId:
          String(orderProductId),

        estimatePart:
          String(estimatePart),

        sourcePart:
          String(sourcePart),

        createdAt:
          new Date().toISOString(),

        partsBefore:
          Array.isArray(partsBefore)
            ? partsBefore.map(
              part =>
                String(part)
              )
            : [],

        createdAt:
          new Date().toISOString()         
            
      }
    );
  }

  function clearPendingDuplicate() {

    if (
      fs.existsSync(
        pendingDuplicateFile
      )
    ) {
      fs.unlinkSync(
        pendingDuplicateFile
      );
    }
  }

  async function verifySession() {

    const url =
      page.url();

    if (
      /login|licensecheck/i.test(
        url
      )
    ) {
      throw new Error(
        'Pace session expired.'
      );
    }
  }

  async function waitForPage() {

    await page.waitForLoadState(
      'domcontentloaded'
    ).catch(
      () => null
    );

    await page.waitForTimeout(
      300
    );
  }

  async function inspectPendingDuplicateRecovery() {

    const pending =
      getPendingDuplicate();

    if (!pending) {
      return {
        status:
          'clear',

        pending:
          null,

        currentParts:
          [],

        newParts:
          []
      };
    }

    if (
      String(
        pending.orderNumber
      ) !==
        String(orderNumber) ||
      String(
        pending.paceJob
      ) !==
        String(paceJobNumber)
    ) {
      throw new Error(
        `JOBPART RECOVERY SAFETY STOP: pending duplicate marker does not match ` +
        `OPS Order ${orderNumber} / Pace Job ${paceJobNumber}.`
      );
    }

    await installFirewall();

    await page.goto(
      `${base}/object/Job/detail/${encodeURIComponent(paceJobNumber)}`,
      {
        waitUntil:
          'domcontentloaded',

        timeout:
          30000
      }
    );

    await verifySession();

    const currentParts =
      (
        await readJobParts()
      )
        .map(
          item =>
            String(
              item.part
            )
        )
        .filter(Boolean);

    const before =
      Array.isArray(
        pending.partsBefore
      )
        ? pending.partsBefore.map(
            part =>
              String(part)
          )
        : [];

    const newParts =
      currentParts.filter(
        part =>
          !before.includes(part)
      );

    let status;

    if (
      newParts.length === 0
    ) {
      status =
        'no_new_part_detected';

    } else if (
      newParts.length === 1
    ) {
      status =
        'one_new_part_detected';

    } else {
      status =
        'ambiguous';
    }

    return {
      status,
      pending,
      currentParts,
      newParts
    };
  }

  /*
   FIREWALL
   */

  async function installFirewall() {

    if (firewallInstalled) {
      return;
    }

    firewallInstalled = true;

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

        const requestURL =
          request.url();

        const decodedURL =
          decodeURIComponent(
            requestURL
          );

        const bodyRaw =
          request.postData() || '';

        const body =
          decodeBody(
            bodyRaw
          );

        /*
         No POST whatsoever unless the caller
         explicitly enabled writes.
         */
        if (!allowWrites) {

          console.log(
            'BLOCKED PACE POST - WRITES DISABLED:',
            requestURL
          );

          await route.abort();
          return;
        }

        /*
         DUPLICATE JOB PART
         */
        if (
          allowedWrite &&
          allowedWrite.type ===
            'DUPLICATE_PART'
        ) {

          const sourcePart =
            allowedWrite.sourcePart;

          const correctURL =
            decodedURL.includes(
              `/object/JobPart/duplicate/${sourcePart}`
            );

          const correctSource =
            body.includes(
              sourcePart
            );

          const existingJob =
            body.includes(
              'Existing Job'
            );

          const duplicate =
            body.includes(
              'Duplicate'
            );

          if (
            correctURL &&
            correctSource &&
            existingJob &&
            duplicate
          ) {

            console.log(
              `ALLOWING JOB PART DUPLICATE: ${sourcePart}`
            );

            allowedWrite =
              null;

            await route.continue();
            return;
          }
        }

        /*
         * UPDATE JOB PART
         */
        if (
          allowedWrite &&
          allowedWrite.type ===
            'UPDATE_PART'
        ) {

          const {
            part,
            quantity,
            jobProductId
          } = allowedWrite;

          const correctURL =
            decodedURL.includes(
              `/object/JobPart/detail/${part}`
            );

          const params =
            new URLSearchParams(
              bodyRaw
            );

          const ordered =
            params.get(
              'qtyOrderedHeader'
            );

          const mfg =
            params.get(
              'qtyToMfg'
            );

          const submittedProduct =
            params.get(
              'jobProduct'
            );

          const update =
            params.get(
              'updateForm'
            );

          const quantityMatches =
            normalizeQuantity(
              ordered
            ) ===
              normalizeQuantity(
                quantity
              ) &&
            normalizeQuantity(
              mfg
            ) ===
              normalizeQuantity(
                quantity
              );

          const productMatches =
            !jobProductId ||
            String(
              submittedProduct
            ) ===
              String(
                jobProductId
              );

          if (
            correctURL &&
            quantityMatches &&
            productMatches &&
            update === 'Update'
          ) {

            console.log(
              `ALLOWING JOB PART UPDATE: ${part}`
            );

            allowedWrite =
              null;

            await route.continue();
            return;
          }
        }

        console.log('');
        console.log(
          'BLOCKED UNEXPECTED PACE POST:'
        );

        console.log(
          requestURL
        );

        await route.abort();
      }
    );
  }

  /*
   * READ ACTUAL JOB PARTS
   */

  async function readJobParts() {

    const keys =
      page.locator(
        'input[name="JobPart_N1002F.primaryKey"]'
      );

    const products =
      page.locator(
        'select[name="JobPart_N1002F.jobProduct2"]'
      );

    const descriptions =
      page.locator(
        'input[name="JobPart_N1002F.description"]'
      );

    const count =
      await keys.count();

    const results = [];

    for (
      let i = 0;
      i < count;
      i++
    ) {

      results.push({
        part:
          await keys
            .nth(i)
            .inputValue(),

        jobProduct:
          await products
            .nth(i)
            .inputValue(),

        description:
          await descriptions
            .nth(i)
            .inputValue()
      });
    }

    return results;
  }

  async function inspectJobParts() {

    await installFirewall();

    const url =
      `${base}/object/Job/detail/${encodeURIComponent(paceJobNumber)}`;

    await page.goto(
      url,
      {
        waitUntil:
          'domcontentloaded',
        timeout:
          30000
      }
    );

    await verifySession();

    const parts =
      await readJobParts();

    return parts;
  }

  /*
   * VERIFY PART BELONGS TO JOB
   */

  async function verifyPartOwnership(
    part
  ) {

    const url =
      `${base}/object/JobPart/detail/${encodeURIComponent(part)}`;

    await page.goto(
      url,
      {
        waitUntil:
          'domcontentloaded',
        timeout:
          30000
      }
    );

    await verifySession();

    const partJob =
      clean(
        await page
          .locator(
            'input[name="jobValue"]'
          )
          .inputValue()
      );

    if (
      partJob !==
      paceJobNumber
    ) {
      throw new Error(
        `SAFETY STOP: Part ${part} belongs to Job ${partJob}, expected ${paceJobNumber}.`
      );
    }

    return true;
  }

  /*
   * DUPLICATE PART
   */

  async function duplicatePart({
    sourcePart,
    orderProductId,
    estimatePart
  }) {

    if (!allowWrites) {
      throw new Error(
        'duplicatePart called while allowWrites=false.'
      );
    }

    await installFirewall();

    sourcePart =
      String(
        sourcePart
      ).trim();
    
    const unresolvedDuplicate =
      getPendingDuplicate();

    if (unresolvedDuplicate) {
      throw new Error(
        `JOBPART RECOVERY REQUIRED: an unresolved duplicate operation exists. ` +
        `Do not duplicate another Pace JobPart until it is reconciled. ` +
        `${JSON.stringify(unresolvedDuplicate)}`
      );
    }

    await verifyPartOwnership(
      sourcePart
    );

    console.log(
      `Duplicating ${sourcePart}...`
    );

    const duplicateURL =
      `${base}/object/JobPart/duplicate/${encodeURIComponent(sourcePart)}`;

    await page.goto(
      duplicateURL,
      {
        waitUntil:
          'domcontentloaded',
        timeout:
          30000
      }
    );

    await verifySession();

    const type =
      await page
        .locator(
          'select[name="type"]'
        )
        .inputValue();

    const job =
      await page
        .locator(
          'select[name="job"]'
        )
        .inputValue();

    if (
      type !== 'Existing Job' ||
      String(job) !==
        paceJobNumber
    ) {

      throw new Error(
        `Duplicate safety check failed. Type=${type}, Job=${job}, Expected Job=${paceJobNumber}`
      );
    }

    /*
     Pace can render before cloneJSON
     finishes populating.
     */
    const cloneField =
      page.locator(
        'input[name="cloneJSON"]'
      );

    await cloneField.waitFor({
      state:
        'attached',
      timeout:
        30000
    });

    let cloneRaw = '';

    for (
      let attempt = 1;
      attempt <= 40;
      attempt++
    ) {

      cloneRaw =
        await cloneField
          .inputValue();

      if (
        cloneRaw &&
        cloneRaw
          .trim()
          .startsWith('{') &&
        cloneRaw
          .trim()
          .endsWith('}')
      ) {
        break;
      }

      await page.waitForTimeout(
        250
      );
    }

    if (
      !cloneRaw ||
      !cloneRaw.trim()
    ) {

      throw new Error(
        'Duplicate page loaded, but cloneJSON remained empty. No duplicate was attempted.'
      );
    }

    let clone;

    try {

      clone =
        JSON.parse(
          cloneRaw
        );

    } catch {

      throw new Error(
        `cloneJSON was present but invalid JSON. No duplicate was attempted. Length=${cloneRaw.length}`
      );
    }

    if (
      clone.objectType !==
      'JobPart'
    ) {

      throw new Error(
        `Duplicate object type mismatch: ${clone.objectType}`
      );
    }

    if (
      clone.objectKey !==
      sourcePart
    ) {

      throw new Error(
        `Duplicate source mismatch. Expected ${sourcePart}, got ${clone.objectKey}`
      );
    }

    const requiredCloneGroups = [
      'JobPartPressForm',
      'JobPartSizeAllowance',
      'JobMaterial',
      'JobPartFinishingOp',
      'JobPartPrePressOp'
    ];

    console.log('');
    console.log(
      'Duplicate production groups:'
    );

    for (
      const groupName of
      requiredCloneGroups
    ) {

      const group =
        clone.children?.[
          groupName
        ];

      if (!group) {

        throw new Error(
          `Required duplicate group missing: ${groupName}`
        );
      }

      if (
        group.cloneAll !== true
      ) {

        throw new Error(
          `${groupName} is not configured to clone.`
        );
      }

      console.log(
        `${groupName}: ${group.childInstructions?.length || 0} item(s)`
      );
    }

    console.log(
      'Duplicate clone instructions verified.'
    );

    allowedWrite = {
      type:
        'DUPLICATE_PART',

      sourcePart
    };

    await page.goto(
      `${base}/object/Job/detail/${encodeURIComponent(paceJobNumber)}`,
      {
        waitUntil:
          'domcontentloaded',

        timeout:
          30000
      }
    );

    await verifySession();

    const partsBeforeDuplicate =
      (
        await readJobParts()
      )
        .map(
          item =>
            String(
              item.part
            )
        ) 
        .filter(Boolean);

    if (
      !partsBeforeDuplicate.includes(
        sourcePart
      )
    ) {
      throw new Error(
        `Duplicate safety check failed: source Part ${sourcePart} ` +
        `was not found on Pace Job ${paceJobNumber} before duplication.`
      );
    }

    console.log(
      'JobParts before duplicate:',
      partsBeforeDuplicate.join(', ')
    );

    recordPendingDuplicate({
      orderProductId,
      estimatePart,
      sourcePart,
      partsBefore:
        partsBeforeDuplicate
    });

    await Promise.all([

      page
        .waitForNavigation({
          waitUntil:
            'domcontentloaded',
          timeout:
            30000
        })
        .catch(
          () => null
        ),

      page
        .locator(
          'input[name="updateForm"][value="Duplicate"]'
        )
        .click()
    ]);

    await waitForPage();

    /*
     If this was not consumed by the
     firewall, no write took place.
     */
    if (
      allowedWrite !== null
    ) {

      allowedWrite =
        null;

      throw new Error(
        'Duplicate POST was never allowed.'
      );
    }

    const currentURL =
      decodeURIComponent(
        page.url()
      );

    const jobPattern =
      escapeRegex(
        paceJobNumber
      );

    const match =
      currentURL.match(
        new RegExp(
          `JobPart/detail/(${jobPattern}:\\d+)`,
          'i'
        )
      );

    if (!match) {

      throw new Error(
        `Duplicate may have completed, but the new Part number could not be captured. STOP and inspect Pace Job ${paceJobNumber} before rerunning.`
      );
    }

    const newPart =
      match[1];

    console.log(
      'Created Job Part:',
      newPart
    );

    return newPart;
  }

  /*
   * UPDATE QUANTITY / JOB PRODUCT
   */

  async function updatePart({
    part,
    quantity,
    jobProductId = null
  }) {

    if (!allowWrites) {
      throw new Error(
        'updatePart called while allowWrites=false.'
      );
    }

    await installFirewall();

    part =
      String(part).trim();

    quantity =
      String(quantity).trim();

    await verifyPartOwnership(
      part
    );

    const partURL =
      `${base}/object/JobPart/detail/${encodeURIComponent(part)}`;

    await page.goto(
      partURL,
      {
        waitUntil:
          'domcontentloaded',
        timeout:
          30000
      }
    );

    await verifySession();

    /*
     Only change JobProduct when caller
     provides an explicit, verified ID.
     */
    if (jobProductId) {

      jobProductId =
        String(
          jobProductId
        );

      const productSelect =
        page.locator(
          'select[name="jobProduct"]'
        );

      const optionExists =
        await productSelect
          .locator(
            `option[value="${jobProductId}"]`
          )
          .count();

      if (!optionExists) {

        throw new Error(
          `JobProduct ${jobProductId} is not available on Part ${part}.`
        );
      }

      await productSelect
        .selectOption(
          jobProductId
        );
    }

    await page
      .locator(
        'input[name="qtyOrderedHeader"]'
      )
      .fill(
        quantity
      );

    await page
      .locator(
        'input[name="qtyToMfg"]'
      )
      .fill(
        quantity
      );

    /*
     Never modify input[name="description"].
     That is the overall Job description.
     */

    allowedWrite = {
      type:
        'UPDATE_PART',

      part,

      quantity,

      jobProductId:
        jobProductId || null
    };

    await Promise.all([

      page
        .waitForNavigation({
          waitUntil:
            'domcontentloaded',
          timeout:
            30000
        })
        .catch(
          () => null
        ),

      page
        .locator(
          'input[name="updateForm"][value="Update"]'
        )
        .first()
        .click()
    ]);

    await waitForPage();

    if (
      allowedWrite !== null
    ) {

      allowedWrite =
        null;

      throw new Error(
        'Part Update POST was never allowed.'
      );
    }

    /*
     * Verify saved values.
     */
    await page.goto(
      partURL,
      {
        waitUntil:
          'domcontentloaded',
        timeout:
          30000
      }
    );

    await verifySession();

    const savedOrdered =
      normalizeQuantity(
        await page
          .locator(
            'input[name="qtyOrderedHeader"]'
          )
          .inputValue()
      );

    const savedMfg =
      normalizeQuantity(
        await page
          .locator(
            'input[name="qtyToMfg"]'
          )
          .inputValue()
      );

    const savedProduct =
      clean(
        await page
          .locator(
            'select[name="jobProduct"]'
          )
          .inputValue()
          .catch(
            () => ''
          )
      );

    if (
      savedOrdered !==
        normalizeQuantity(
          quantity
        ) ||
      savedMfg !==
        normalizeQuantity(
          quantity
        )
    ) {

      throw new Error(
        `Part quantity verification failed for ${part}. Expected=${quantity}, Ordered=${savedOrdered}, Mfg=${savedMfg}`
      );
    }

    if (
      jobProductId &&
      savedProduct !==
        jobProductId
    ) {

      throw new Error(
        `JobProduct verification failed for ${part}. Expected=${jobProductId}, Saved=${savedProduct}`
      );
    }

    console.log(
      `Verified ${part}: Qty=${quantity}${jobProductId ? ` JobProduct=${jobProductId}` : ''}`
    );

    return {
      part,
      quantity:
        savedOrdered,
      qtyToMfg:
        savedMfg,
      jobProduct:
        savedProduct
    };
  }

  /*
   STATE
   */

  function loadPartState() {

    return loadJSON(
      stateFile,
      {
        orderNumber,
        paceJob:
          paceJobNumber,
        parts: {}
      }
    );
  }

  function savePartState(
    state
  ) {

    state.orderNumber =
      orderNumber;

    state.paceJob =
      paceJobNumber;

    saveJSONAtomic(
      stateFile,
      state
    );
  }

  /*
   RECONCILE
   */

  async function reconcile({
    products,
    sourcePartMap
  }) {

    if (!allowWrites) {
      throw new Error(
        'reconcile called while allowWrites=false.'
      );
    }

    if (
      !Array.isArray(products) ||
      products.length === 0
    ) {

      throw new Error(
        'No OPS products supplied to JobPart reconciler.'
      );
    }

    if (
      !sourcePartMap ||
      typeof sourcePartMap !==
        'object'
    ) {

      throw new Error(
        'sourcePartMap is required.'
      );
    }

    await installFirewall();

    const state =
      loadPartState();

    state.parts =
      state.parts || {};
    
    /*
     VALIDATE PERSISTED PART STATE
     Every OPS OrderProduct must map to one
     unique actual Pace JobPart.
     */

    const persistedPartOwners =
      new Map();

    for (
      const [
        persistedOrderProductId,
        persistedRecord
      ] of Object.entries(
        state.parts
      )
    ) {

      const persistedPart =
        String(
          persistedRecord?.jobPart || ''
        ).trim();

      if (!persistedPart) {
        throw new Error(
          `Persisted JobPart state is invalid: OPS OrderProduct ` +
          `${persistedOrderProductId} has no jobPart.`
        );
      }

      if (
        !persistedPart.startsWith(
          `${paceJobNumber}:`
        )
      ) {
        throw new Error(
          `Persisted JobPart state is invalid: OPS OrderProduct ` +
          `${persistedOrderProductId} points to ${persistedPart}, ` +
          `which does not belong to Pace Job ${paceJobNumber}.`
        );
      }

      if (
        persistedPartOwners.has(
          persistedPart
        )
      ) {

        const firstOwner =
          persistedPartOwners.get(
            persistedPart
          );

        throw new Error(
          `Persisted JobPart conflict: OPS OrderProducts ` +
          `${firstOwner} and ${persistedOrderProductId} both map to ` +
          `${persistedPart}.`
        );
      }

      persistedPartOwners.set(
        persistedPart,
        String(
          persistedOrderProductId
        )
      );
    }

    /*
     Track how many OPS lines have already
     consumed each converted source part.
     */
    const usedByEstimatePart =
      {};

    for (
      const product of
      products
    ) {

      const orderProductId =
        String(
          product.orderProductId
        );

      const estimatePart =
        String(
          product.estimatePart || ''
        );

      const quantity =
        String(
          product.quantity
        );

      const jobProductId =
        product.jobProductId
          ? String(
              product.jobProductId
            )
          : null;

      if (!orderProductId) {
        throw new Error(
          'Product missing orderProductId.'
        );
      }

      if (!estimatePart) {

        throw new Error(
          `OPS Product ${orderProductId} is missing estimatePart.`
        );
      }

      const sourcePart =
        sourcePartMap[
          estimatePart
        ];

      if (!sourcePart) {

        throw new Error(
          `No actual Pace source JobPart supplied for Estimate Part ${estimatePart}.`
        );
      }

      /*
       Recovery/idempotency:
       If this OPS line was already assigned
       an actual Pace Part, reuse it.
       */
      let actualPart =
        state.parts[
          orderProductId
        ]?.jobPart || '';

      if (actualPart) {

        console.log(
          `Reusing stored mapping: OPS ${orderProductId} -> ${actualPart}`
        );

        await verifyPartOwnership(
          actualPart
        );

      } else {

        const alreadyUsed =
          usedByEstimatePart[
            estimatePart
          ] || 0;

        const sourcePartAlreadyPersisted =
          persistedPartOwners.has(
            sourcePart
          );

        const sourcePartPersistedOwner =
          sourcePartAlreadyPersisted
            ? persistedPartOwners.get(
                sourcePart
              )
            : null;

        /*
         First OPS line for this Estimate
         Part uses the actual converted part.
         */
        if (
          alreadyUsed === 0 &&
          !sourcePartAlreadyPersisted
        ) {

          actualPart =
            sourcePart;

          await verifyPartOwnership(
            actualPart
          );

        } else {

          /*
           Additional OPS lines mapping to
           the same Estimate Part each need
           their own actual Pace JobPart.
           */
          actualPart =
            await duplicatePart({
              sourcePart,
              orderProductId,
              estimatePart
            });
        }

        state.parts[
          orderProductId
        ] = {
          jobPart:
            actualPart,

          quantity,

          ...(product.artwork
            ? {
                artwork:
                  product.artwork
              }
            : {})
        };

        /*
         Persist immediately after part
         creation so a crash cannot cause us
         to duplicate it again.
         */
        savePartState(
          state
        );

        persistedPartOwners.set(
          actualPart,
          orderProductId
        );

      }

      usedByEstimatePart[
        estimatePart
      ] =
        (
          usedByEstimatePart[
            estimatePart
          ] || 0
        ) + 1;

      /*
       Update / verify quantities.
       */
      await updatePart({
        part:
          actualPart,

        quantity,

        jobProductId
      });

      state.parts[
        orderProductId
      ] = {
        ...state.parts[
          orderProductId
        ],

        jobPart:
          actualPart,

        quantity,

        ...(product.artwork
          ? {
              artwork:
                product.artwork
            }
          : {})
      };

      savePartState(
        state
      );

      if (
        getPendingDuplicate() &&
        getPendingDuplicate()
          .orderProductId ===
          orderProductId
      ) {
        clearPendingDuplicate();
      }

      console.log(
        `OPS OrderProduct ${orderProductId} -> Pace ${actualPart}`
      );
    }

    return state;
  }

  return {
    installFirewall,
    readJobParts,
    inspectJobParts,
    verifyPartOwnership,
    duplicatePart,
    updatePart,
    reconcile,
    loadPartState,
    inspectPendingDuplicateRecovery
  };
}

module.exports = {
  createJobPartReconciler
};
