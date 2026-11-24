function normalizeEstimatePart(
  value
) {

  const parsed =
    parseInt(
      String(value || ''),
      10
    );

  if (
    !Number.isFinite(
      parsed
    )
  ) {

    throw new Error(
      `Invalid Estimate Part: ${value}`
    );
  }

  return String(
    parsed
  ).padStart(
    2,
    '0'
  );
}

function buildSourcePartMap({
  estimateNumber,
  estimateParts,
  origins
}) {

  estimateNumber =
    String(
      estimateNumber
    ).trim();

  if (!estimateNumber) {

    throw new Error(
      'estimateNumber is required.'
    );
  }

  if (
    !Array.isArray(
      estimateParts
    ) ||
    estimateParts.length === 0
  ) {

    throw new Error(
      'estimateParts is required.'
    );
  }

  if (
    !Array.isArray(
      origins
    ) ||
    origins.length === 0
  ) {

    throw new Error(
      'origins is required.'
    );
  }

  /*
   * Repeated OPS products can reference
   * the same Estimate Part.
   *
   * Only one initial converted source part
   * should exist per unique Estimate Part.
   */
  const requiredParts =
    [
      ...new Set(
        estimateParts.map(
          normalizeEstimatePart
        )
      )
    ];

  console.log('');
  console.log(
    'SOURCE PART MAP VALIDATION'
  );

  console.log(
    '----------------------------------------'
  );

  console.log(
    'Estimate:',
    estimateNumber
  );

  console.log(
    'Required Estimate Parts:',
    requiredParts.join(
      ', '
    )
  );

  /*
   * Never accept a JobPart originating from
   * another Estimate.
   */
  for (
    const origin of
    origins
  ) {

    if (
      String(
        origin.estimateNumber
      ) !==
      estimateNumber
    ) {

      throw new Error(
        `SOURCE ESTIMATE MISMATCH. JobPart ${origin.jobPart} came from Estimate ${origin.estimateNumber}, expected ${estimateNumber}.`
      );
    }
  }

  const map = {};

  for (
    const requiredPart of
    requiredParts
  ) {

    const matches =
      origins.filter(
        origin =>
          normalizeEstimatePart(
            origin.estimatePart
          ) ===
          requiredPart
      );

    /*
     * Immediately after conversion we expect
     * exactly one initial Pace JobPart for
     * every selected unique Estimate Part.
     *
     * 0 = conversion didn't produce it.
     * >1 = ambiguity; do not guess.
     */
    if (
      matches.length !==
      1
    ) {

      throw new Error(
        `SOURCE PART MAPPING AMBIGUOUS for Estimate Part ${requiredPart}. Expected exactly 1 initial Pace JobPart, found ${matches.length}: ${matches.map(item => item.jobPart).join(', ')}`
      );
    }

    map[
      requiredPart
    ] =
      matches[0]
        .jobPart;

    console.log(
      `Estimate Part ${requiredPart} -> ${matches[0].jobPart}`
    );
  }

  /*
   * Make sure Pace didn't produce some
   * unexpected source Estimate Part.
   */
  const unexpected =
    origins.filter(
      origin =>
        !requiredParts.includes(
          normalizeEstimatePart(
            origin.estimatePart
          )
        )
    );

  if (
    unexpected.length
  ) {

    throw new Error(
      `Unexpected Pace source JobParts found: ${unexpected.map(item => `${item.jobPart}=Estimate Part ${item.estimatePart}`).join(', ')}`
    );
  }

  return map;
}

module.exports = {
  buildSourcePartMap,
  normalizeEstimatePart
};