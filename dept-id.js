const fs = require('fs');
const { PDFParse } = require('pdf-parse');

async function extractDeptId(jobTicketPath) {
  if (!fs.existsSync(jobTicketPath)) {
    throw new Error(
      `Job ticket not found: ${jobTicketPath}`
    );
  }

  const buffer = fs.readFileSync(
    jobTicketPath
  );

  const parser = new PDFParse({
    data: buffer
  });

  const result = await parser.getText();

  await parser.destroy();

  const lines = (result.text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(
      /^Dept\s*Id\s*:\s*(.*)$/i
    );

    if (!match) {
      continue;
    }

    let deptId = match[1].trim();

    /*
     * OPS may wrap the Dept ID onto the next PDF line:
     *
     * Dept Id: XX-EXAMPLE-
     * 12345
     */
    const nextLine = lines[i + 1];

    if (
      nextLine &&
      deptId.endsWith('-') &&
      /^\d+$/.test(nextLine)
    ) {
      deptId += nextLine;
    }

    if (!deptId) {
      throw new Error(
        'Dept ID label was found, but the value was empty.'
      );
    }

    return deptId;
  }

  throw new Error(
    'Dept ID was not found in OPS job ticket.'
  );
}

module.exports = {
  extractDeptId
};