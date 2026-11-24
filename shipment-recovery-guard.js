function evaluateShipmentRecovery({
  paceJobNumber,
  existingShipmentIds = [],
  localShipmentState = null,
  writeRequested = false
}) {

  const job =
    String(
      paceJobNumber || ''
    ).trim();

  if (!/^\d+$/.test(job)) {
    throw new Error(
      `Invalid Pace Job Number: ${job}`
    );
  }

  const ids =
    Array.isArray(
      existingShipmentIds
    )
      ? existingShipmentIds
          .map(
            id =>
              String(
                id || ''
              ).trim()
          )
          .filter(Boolean)
      : [];

  const localCreated =
    localShipmentState &&
    localShipmentState.status ===
      'shipment_created';

  /*
   * Local state already says shipment exists.
   */

  if (localCreated) {

    const localJob =
      String(
        localShipmentState
          .record
          ?.paceJobNumber ||
        ''
      ).trim();

    const localShipment =
      String(
        localShipmentState
          .record
          ?.shipmentNumber ||
        ''
      ).trim();

    if (
      localJob !==
      job
    ) {
      return {
        action:
          'manual_review',

        reason:
          `Local shipment state belongs to Pace Job ${localJob}, expected ${job}.`
      };
    }

    return {
      action:
        'already_created',

      reason:
        `Local state already records Pace Shipment ${localShipment} for Job ${job}.`
    };
  }

  /*
   * Pace contains shipment records,
   * but local state is missing.
   */

  if (ids.length) {

    if (writeRequested) {
      return {
        action:
          'recovery_required',

        reason:
          `Pace Job ${job} already contains shipment(s) ${ids.join(', ')} but no local shipment state exists. No new shipment may be created.`
      };
    }

    return {
      action:
        'inspect_existing',

      reason:
        `Pace Job ${job} contains existing shipment(s) ${ids.join(', ')}. Read-only inspection is allowed.`
    };
  }

  /*
   * No local or Pace shipment.
   */

  return {
    action:
      'clear',

    reason:
      `No existing shipment is recorded for Pace Job ${job}.`
  };
}

module.exports = {
  evaluateShipmentRecovery
};