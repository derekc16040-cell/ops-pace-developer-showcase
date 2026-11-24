const fs = require('fs');
const path = require('path');

const {
  getConversionState
} = require(
  './conversion-lock'
);

const {
  getShipmentState
} = require(
  './shipment-state'
);

const STATE_DIR =
  path.join(
    __dirname,
    'integration-state'
  );

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

function readJsonIfExists(
  file
) {

  if (
    !fs.existsSync(file)
  ) {
    return null;
  }

  return JSON.parse(
    fs.readFileSync(
      file,
      'utf8'
    )
  );
}

function getPostCreateResumeState(
  orderNumber
) {

  const safe =
    safeOrderNumber(
      orderNumber
    );

  const conversionState =
    getConversionState(
      safe
    );

  /*
   * ======================================
   * CONVERSION NOT STARTED
   * ======================================
   */

  if (
    conversionState.status ===
    'clear'
  ) {

    return {
      orderNumber:
        safe,

      jobCreated:
        false,

      paceJobNumber:
        null,

      conversionStatus:
        'clear',

      nextStep:
        'conversion'
    };
  }

  /*
   * ======================================
   * UNRESOLVED CONVERSION LOCK
   * ======================================
   */

  if (
    conversionState.status ===
    'conversion_started'
  ) {

    return {
      orderNumber:
        safe,

      jobCreated:
        false,

      paceJobNumber:
        null,

      conversionStatus:
        'conversion_started',

      blocked:
        true,

      nextStep:
        'manual_review',

      reason:
        'Unresolved conversion lock exists. Pace conversion may already have completed.'
    };
  }

  /*
   * ======================================
   * PACE JOB EXISTS
   * ======================================
   */

  const created =
    conversionState.record;

  const paceJobNumber =
    String(
      created.jobNumber || ''
    ).trim();

  if (!paceJobNumber) {

    throw new Error(
      `OPS Order ${safe} is marked job_created but has no Pace Job Number.`
    );
  }

  /*
   * ======================================
   * PART STATE
   * ======================================
   */

  const partsFile =
    path.join(
      STATE_DIR,
      `ops-${safe}-parts.json`
    );

  const partsState =
    readJsonIfExists(
      partsFile
    );

  if (!partsState) {

    return {
      orderNumber:
        safe,

      jobCreated:
        true,

      paceJobNumber,

      conversionStatus:
        'job_created',

      partsStateExists:
        false,

      mappedPartsCount:
        0,

      artworkAttachedCount:
        0,

      artworkComplete:
        false,

      shipmentCreated:
        false,

      nextStep:
        'reconcile'
    };
  }

  /*
   * Parts state must belong to the same
   * Pace Job as created-state.
   */

  const partsPaceJob =
    String(
      partsState.paceJob || ''
    ).trim();

  if (
    partsPaceJob !==
    paceJobNumber
  ) {

    return {
      orderNumber:
        safe,

      jobCreated:
        true,

      paceJobNumber,

      conversionStatus:
        'job_created',

      blocked:
        true,

      nextStep:
        'manual_review',

      reason:
        `Parts state references Pace Job ${partsPaceJob || '(blank)'}, but created-state references ${paceJobNumber}.`
    };
  }

  const parts =
    partsState.parts &&
    typeof partsState.parts ===
      'object'
      ? partsState.parts
      : {};

  const entries =
    Object.entries(
      parts
    );

  /*
   * ======================================
   * VALIDATE PERSISTED PART MAPPINGS
   * ======================================
   */

  for (
    const [
      orderProductId,
      record
    ] of entries
  ) {

    if (
      !record ||
      !record.jobPart
    ) {

      return {
        orderNumber:
          safe,

        jobCreated:
          true,

        paceJobNumber,

        conversionStatus:
          'job_created',

        blocked:
          true,

        nextStep:
          'manual_review',

        reason:
          `OPS OrderProduct ${orderProductId} has an invalid persisted JobPart mapping.`
      };
    }

    if (
      !String(
        record.jobPart
      ).startsWith(
        `${paceJobNumber}:`
      )
    ) {

      return {
        orderNumber:
          safe,

        jobCreated:
          true,

        paceJobNumber,

        conversionStatus:
          'job_created',

        blocked:
          true,

        nextStep:
          'manual_review',

        reason:
          `OPS OrderProduct ${orderProductId} maps to ${record.jobPart}, which does not belong to Pace Job ${paceJobNumber}.`
      };
    }
  }

  /*
   * Zero mappings means reconciliation
   * still needs to run.
   */

  if (
    entries.length === 0
  ) {

    return {
      orderNumber:
        safe,

      jobCreated:
        true,

      paceJobNumber,

      conversionStatus:
        'job_created',

      partsStateExists:
        true,

      mappedPartsCount:
        0,

      artworkAttachedCount:
        0,

      artworkComplete:
        false,

      shipmentCreated:
        false,

      nextStep:
        'reconcile'
    };
  }

  /*
   * ======================================
   * ARTWORK STATE
   * ======================================
   */

  const artworkAttached =
    entries.filter(
      ([
        ,
        record
      ]) =>
        record.artworkAttached ===
          true
    );

  const artworkComplete =
    artworkAttached.length ===
    entries.length;

  /*
   * Artwork must finish before shipment.
   */

  if (!artworkComplete) {

    return {
      orderNumber:
        safe,

      jobCreated:
        true,

      paceJobNumber,

      conversionStatus:
        'job_created',

      partsStateExists:
        true,

      mappedPartsCount:
        entries.length,

      artworkAttachedCount:
        artworkAttached.length,

      artworkComplete:
        false,

      shipmentCreated:
        false,

      nextStep:
        'artwork',

      parts:
        Object.fromEntries(
          entries
        )
    };
  }

  /*
   * ======================================
   * SHIPMENT STATE
   * ======================================
   */

  const shipmentState =
    getShipmentState(
      safe
    );

  if (
    shipmentState.status ===
    'shipment_created'
  ) {

    const shipmentRecord =
      shipmentState.record;

    /*
     * Shipment must belong to same
     * Pace Job.
     */

    if (
      String(
        shipmentRecord.paceJobNumber
      ) !==
      paceJobNumber
    ) {

      return {
        orderNumber:
          safe,

        jobCreated:
          true,

        paceJobNumber,

        conversionStatus:
          'job_created',

        blocked:
          true,

        nextStep:
          'manual_review',

        reason:
          `Shipment state references Pace Job ${shipmentRecord.paceJobNumber}, but created-state references ${paceJobNumber}.`
      };
    }

    /*
     * Conversion, parts, artwork and
     * shipment are complete.
     */

    return {
      orderNumber:
        safe,

      jobCreated:
        true,

      paceJobNumber,

      conversionStatus:
        'job_created',

      partsStateExists:
        true,

      mappedPartsCount:
        entries.length,

      artworkAttachedCount:
        artworkAttached.length,

      artworkComplete:
        true,

      shipmentCreated:
        true,

      shipmentNumber:
        String(
          shipmentRecord.shipmentNumber
        ),

      nextStep:
        'complete',

      parts:
        Object.fromEntries(
          entries
        )
    };
  }

  /*
   * ======================================
   * READY FOR SHIPMENT
   * ======================================
   */

  return {
    orderNumber:
      safe,

    jobCreated:
      true,

    paceJobNumber,

    conversionStatus:
      'job_created',

    partsStateExists:
      true,

    mappedPartsCount:
      entries.length,

    artworkAttachedCount:
      artworkAttached.length,

    artworkComplete:
      true,

    shipmentCreated:
      false,

    nextStep:
      'shipment',

    parts:
      Object.fromEntries(
        entries
      )
  };
}

module.exports = {
  getPostCreateResumeState
};