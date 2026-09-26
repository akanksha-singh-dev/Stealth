module.exports = {
  css: `
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      font-size: 11pt;
      line-height: 1.6;
      color: #1a1a2e;
      margin: 0;
      padding: 0;
    }
    h1 {
      color: #0f3460;
      font-size: 22pt;
      border-bottom: 3px solid #0f3460;
      padding-bottom: 8px;
      margin-top: 30px;
    }
    h2 {
      color: #16213e;
      font-size: 16pt;
      border-bottom: 1.5px solid #e0e0e0;
      padding-bottom: 6px;
      margin-top: 25px;
    }
    h3 {
      color: #1a1a2e;
      font-size: 13pt;
      margin-top: 20px;
    }
    h4 {
      color: #533483;
      font-size: 11.5pt;
    }
    table {
      border-collapse: collapse;
      width: 100%;
      margin: 12px 0;
      font-size: 10pt;
    }
    th {
      background-color: #0f3460;
      color: white;
      padding: 8px 10px;
      text-align: left;
    }
    td {
      padding: 7px 10px;
      border: 1px solid #ddd;
    }
    tr:nth-child(even) {
      background-color: #f8f9fa;
    }
    code {
      background: #f0f0f0;
      padding: 2px 5px;
      border-radius: 3px;
      font-size: 9.5pt;
    }
    pre {
      background: #1a1a2e;
      color: #e0e0e0;
      padding: 14px;
      border-radius: 6px;
      font-size: 9pt;
      overflow-x: auto;
    }
    pre code {
      background: none;
      color: inherit;
    }
    blockquote {
      border-left: 4px solid #533483;
      margin: 12px 0;
      padding: 8px 16px;
      background: #f5f0ff;
      border-radius: 0 6px 6px 0;
    }
    hr {
      border: none;
      border-top: 1px solid #ccc;
      margin: 20px 0;
    }
    .markdown-alert-note {
      border-left: 4px solid #0969da;
      background: #f0f7ff;
      padding: 10px 14px;
      margin: 12px 0;
      border-radius: 0 6px 6px 0;
    }
    .markdown-alert-warning {
      border-left: 4px solid #d4a017;
      background: #fff8e1;
      padding: 10px 14px;
      margin: 12px 0;
      border-radius: 0 6px 6px 0;
    }
    .markdown-alert-caution {
      border-left: 4px solid #cf222e;
      background: #fff5f5;
      padding: 10px 14px;
      margin: 12px 0;
      border-radius: 0 6px 6px 0;
    }
    .markdown-alert-important {
      border-left: 4px solid #8250df;
      background: #f5f0ff;
      padding: 10px 14px;
      margin: 12px 0;
      border-radius: 0 6px 6px 0;
    }
  `,
  pdf_options: {
    format: 'A4',
    margin: {
      top: '30mm',
      bottom: '25mm',
      left: '20mm',
      right: '20mm'
    },
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: '<div style="font-size:8pt; color:#999; width:100%; text-align:center; padding:5px 20mm;">StealthEra — Rehabilitation Recovery Intelligence Platform — TDD v1.0</div>',
    footerTemplate: '<div style="font-size:8pt; color:#999; width:100%; text-align:center; padding:5px 20mm;">Page <span class="pageNumber"></span> of <span class="totalPages"></span> | Confidential</div>'
  }
};
