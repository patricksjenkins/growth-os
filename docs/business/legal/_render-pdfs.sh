#!/bin/bash
# Render the legal markdown templates to clean PDFs.
#
# Output: ./pdf/FGA-MSA-Template.pdf
#         ./pdf/FGA-SOW-Template.pdf
#         ./pdf/FGA-AUP.pdf
#
# Requires: pandoc, Google Chrome (for headless PDF). Both already installed.

set -e
cd "$(dirname "$0")"

mkdir -p pdf

# Lightweight inline CSS for a clean professional document look — neutral
# (not dark theme), readable serif body, sans-serif headings, FGA signal
# green for section dividers. Designed to print cleanly on US Letter.
CSS=$(cat <<'EOF'
<style>
  @page { size: Letter; margin: 0.85in 0.95in; }
  * { box-sizing: border-box; }
  body {
    font: 11pt/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    color: #1F2937;
    max-width: 7.5in;
    margin: 0 auto;
  }
  h1 {
    font-size: 22pt;
    margin: 0 0 18pt;
    color: #0B1228;
    border-bottom: 2px solid #22C55E;
    padding-bottom: 8pt;
  }
  h2 {
    font-size: 14pt;
    margin: 22pt 0 10pt;
    color: #0B1228;
    page-break-after: avoid;
  }
  h3 {
    font-size: 11pt;
    margin: 16pt 0 6pt;
    color: #0B1228;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  p { margin: 0 0 9pt; }
  ul, ol { margin: 0 0 9pt 0; padding-left: 24pt; }
  li { margin: 0 0 4pt; }
  table {
    border-collapse: collapse;
    width: 100%;
    margin: 0 0 12pt;
    font-size: 10pt;
  }
  th, td {
    text-align: left;
    border: 1px solid #D1D5DB;
    padding: 6pt 9pt;
  }
  th { background: #F3F4F6; font-weight: 700; }
  code {
    font-family: "SF Mono", Menlo, monospace;
    font-size: 9.5pt;
    background: #F3F4F6;
    padding: 1pt 4pt;
    border-radius: 2pt;
  }
  hr {
    border: none;
    border-top: 1px solid #D1D5DB;
    margin: 16pt 0;
  }
  blockquote {
    border-left: 3px solid #22C55E;
    margin: 0 0 12pt;
    padding: 4pt 14pt;
    color: #4B5563;
    background: #F9FAFB;
  }
  strong { color: #0B1228; }
  /* Avoid orphan signature lines on the last page */
  h2 + p, p + p { orphans: 3; widows: 3; }
  /* Print niceties */
  @media print {
    a { color: inherit; text-decoration: none; }
  }
</style>
EOF
)

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

render() {
  local md="$1"
  local out="$2"
  local title="$3"

  # 1. Render the markdown to HTML via pandoc
  local html_tmp="pdf/_tmp_${out%.pdf}.html"

  {
    echo "<!DOCTYPE html>"
    echo "<html><head><meta charset='utf-8'>"
    echo "<title>${title}</title>"
    echo "$CSS"
    echo "</head><body>"
    /opt/homebrew/bin/pandoc -f gfm -t html5 "$md"
    echo "</body></html>"
  } > "$html_tmp"

  # 2. Chrome headless prints the HTML to PDF
  "$CHROME" \
    --headless=new \
    --disable-gpu \
    --no-pdf-header-footer \
    --print-to-pdf="$PWD/pdf/$out" \
    "file://$PWD/$html_tmp" 2>/dev/null

  # 3. Clean up the temp HTML
  rm "$html_tmp"

  echo "  ✓ pdf/$out  ($(/usr/bin/du -h "pdf/$out" | /usr/bin/cut -f1))"
}

echo "Rendering legal PDFs..."
render service-agreement-template.md     FGA-MSA-Template.pdf   "First Gen Automate — Master Services Agreement"
render scope-of-work-template.md         FGA-SOW-Template.pdf   "First Gen Automate — Scope of Work"
render acceptable-use-policy.md          FGA-AUP.pdf            "First Gen Automate — Acceptable Use Policy"
render email-signature-workflow.md       FGA-Email-Signature-Workflow.pdf "First Gen Automate — Email Signature Workflow (Internal)"
render client-negotiation-playbook.md    FGA-Negotiation-Playbook.pdf "First Gen Automate — Client Negotiation Playbook (Internal)"
echo "Done. Output in: $PWD/pdf/"
