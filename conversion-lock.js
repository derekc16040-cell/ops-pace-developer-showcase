const fs = require('fs');
const path = require('path');

const STATE_DIR =
  path.join(
    __dirname,
    'integration-state'
  );

function ensureStateDirectory() {
  if (
    !fs.existsSync(STATE_DIR)
  ) {
    fs.mkdirSync(
      STATE_DIR,
      {
        recursive: true
      }
    );
  }
}

function safeOrderNumber(
  orderNumber
) {
  const value =
    String(
      orderNumber || ''
    ).trim();

  if (!value) {
    throw new Error(
      'OPS Order Number is required.'
    );
  }

  if (
    !/^[A-Za-z0-9_-]+$/.test(
      value
    )
  ) {
    throw new Error(
      `Invalid OPS Order Number: ${value}`
    );
  }

  return value;
}

function getPaths(
  orderNumber
) {
  const safe =
    safeOrderNumber(
      orderNumber
    );

  return {
    lock:
      path.join(
        STATE_DIR,
        `ops-${safe}.lock.json`
      ),

    created:
      path.join(
        STATE_DIR,
        `ops-${safe}.created.json`
      )
  };
}

function readJson(
  file
) {
  return JSON.parse(
    fs.readFileSync(
      file,
      'utf8'
    )
  );
}

/*
  CHECK CURRENT ORDER STATE
 */

function getConversionState(
  orderNumber
) {
  ensureStateDirectory();

  const paths =
    getPaths(
      orderNumber
    );

  if (
    fs.existsSync(
      paths.created
    )
  ) {
    return {
      status:
        'job_created',

      record:
        readJson(
          paths.created
        )
    };
  }

  if (
    fs.existsSync(
      paths.lock
    )
  ) {
    return {
      status:
        'conversion_started',

      record:
        readJson(
          paths.lock
        )
    };
  }

  return {
    status:
      'clear',

    record:
      null
  };
}

/*
 ACQUIRE CONVERSION LOCK
 */

function acquireConversionLock({
  orderNumber,
  customerId = null,
  estimateId = null,
  productId = null
}) {
  ensureStateDirectory();

  const safe =
    safeOrderNumber(
      orderNumber
    );

  const state =
    getConversionState(
      safe
    );

  if (
    state.status ===
    'job_created'
  ) {
    throw new Error(
      `DUPLICATE BLOCKED: OPS Order ${safe} ` +
      `was already recorded as Pace Job ` +
      `${state.record.jobNumber}.`
    );
  }

  if (
    state.status ===
    'conversion_started'
  ) {
    throw new Error(
      `DUPLICATE BLOCKED: OPS Order ${safe} ` +
      `already has a conversion lock. ` +
      `Pace conversion may already have occurred. ` +
      `Manual review required before retrying.`
    );
  }

  const paths =
    getPaths(
      safe
    );

  const record = {
    orderNumber:
      safe,

    status:
      'conversion_started',

    startedAt:
      new Date()
        .toISOString(),

    customerId:
      customerId !== null
        ? String(customerId)
        : null,

    estimateId:
      estimateId !== null
        ? String(estimateId)
        : null,

    productId:
      productId !== null
        ? String(productId)
        : null
  };

  try {
    fs.writeFileSync(
      paths.lock,
      JSON.stringify(
        record,
        null,
        2
      ),
      {
        flag: 'wx'
      }
    );

  } catch (error) {
    if (
      error.code ===
      'EEXIST'
    ) {
      throw new Error(
        `DUPLICATE BLOCKED: ` +
        `conversion lock already exists ` +
        `for OPS Order ${safe}.`
      );
    }

    throw error;
  }

  return record;
}

/*
 RECORD CREATED PACE JOB
 */

function recordCreatedJob({
  orderNumber,
  jobNumber
}) {
  ensureStateDirectory();

  const safe =
    safeOrderNumber(
      orderNumber
    );

  const job =
    String(
      jobNumber || ''
    ).trim();

  if (!job) {
    throw new Error(
      'Pace Job Number is required.'
    );
  }

  const paths =
    getPaths(
      safe
    );

  if (
    fs.existsSync(
      paths.created
    )
  ) {
    const existing =
      readJson(
        paths.created
      );

    if (
      String(
        existing.jobNumber
      ) === job
    ) {
      return existing;
    }

    throw new Error(
      `OPS Order ${safe} is already ` +
      `recorded as Pace Job ` +
      `${existing.jobNumber}, not ${job}.`
    );
  }

  if (
    !fs.existsSync(
      paths.lock
    )
  ) {
    throw new Error(
      `Cannot record Pace Job ${job}: ` +
      `OPS Order ${safe} has no conversion lock.`
    );
  }

  const lock =
    readJson(
      paths.lock
    );

  const record = {
    ...lock,

    status:
      'job_created',

    jobNumber:
      job,

    jobCreatedAt:
      new Date()
        .toISOString()
  };

  fs.writeFileSync(
    paths.created,
    JSON.stringify(
      record,
      null,
      2
    ),
    {
      flag: 'wx'
    }
  );

  return record;
}

/*
 ADOPT EXISTING PACE JOB
 */

function adoptExistingJob({
  orderNumber,
  jobNumber,
  reason = 'Existing Pace Job verified and adopted'
}) {
  ensureStateDirectory();

  const safe =
    safeOrderNumber(
      orderNumber
    );

  const job =
    String(
      jobNumber || ''
    ).trim();

  if (!job) {
    throw new Error(
      'Pace Job Number is required.'
    );
  }

  if (
    !/^\d+$/.test(job)
  ) {
    throw new Error(
      `Invalid Pace Job Number: ${job}`
    );
  }

  const state =
    getConversionState(
      safe
    );

  /*
   Already adopted/created.
   */

  if (
    state.status ===
    'job_created'
  ) {

    if (
      String(
        state.record.jobNumber
      ) === job
    ) {
      return state.record;
    }

    throw new Error(
      `OPS Order ${safe} is already recorded as Pace Job ${state.record.jobNumber}, not ${job}.`
    );
  }

  /*
   * Never adopt across an unresolved
   * conversion lock.
   */

  if (
    state.status ===
    'conversion_started'
  ) {
    throw new Error(
      `Cannot adopt Pace Job ${job}: OPS Order ${safe} has an unresolved conversion lock.`
    );
  }

  const paths =
    getPaths(
      safe
    );

  const record = {
    orderNumber:
      safe,

    status:
      'job_created',

    jobNumber:
      job,

    source:
      'adopted_existing_job',

    adoptedAt:
      new Date()
        .toISOString(),

    reason:
      String(reason)
  };

  fs.writeFileSync(
    paths.created,
    JSON.stringify(
      record,
      null,
      2
    ),
    {
      flag:
        'wx'
    }
  );

  return record;
}

module.exports = {
  acquireConversionLock,
  recordCreatedJob,
  adoptExistingJob,
  getConversionState
};
