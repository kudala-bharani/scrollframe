# ScrollFrame PDF

A Chrome extension for capturing long web pages, independently scrolling panels, and accessible embedded frames into a screenshot PDF. Everything needed to run the extension is included in this folder. There is no build step, account, subscription, or external JavaScript download.

## Install in Chrome

1. Extract the ZIP file into a folder you want to keep.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** in the upper-right corner.
4. Click **Load unpacked**.
5. Select the extracted `scrollframe-pdf` folder containing `manifest.json`.
6. Open Chrome's extensions menu (the puzzle icon) and pin **ScrollFrame PDF**.

Chrome loads the extracted folder, not the ZIP itself. Keep that folder in place while you use the extension. If your computer is managed by an organization, its Chrome policy may restrict loading unpacked extensions.

## Capture one scrolling panel

1. Open the web page and wait for its content to load.
2. Click **ScrollFrame PDF** in the toolbar.
3. Choose **Pick a scrolling section**.
4. Move the pointer over the content panel you want. Click when the intended scrolling region is highlighted. Press Escape to cancel selection.
5. Keep the source tab active while capture runs. The extension scrolls the selected region and captures successive views.
6. When the result opens, review the preview, choose your paper size and orientation, and click **Download PDF**.

For a deeply nested page, **Scan page** is another way to choose the target. It lists the detected main page, panels, and accessible frame documents. Select the sections you want and choose **Capture selected**.

## Capture the page and all inner sections

Choose **Capture all sections**. This creates one capture session containing the main page and the detected scrolling sections in page order. Each section starts separately in the exported PDF. The main-page overview can contain a visible portion of a panel that is also captured in full later.

A capture includes up to 40 sections. If more are found, the result is marked partial with a warning; select the remaining sections in a separate capture.

This mode preserves each scrolling surface as a separate section. It does not rebuild the website into a single expanded layout. Hidden tabs, closed accordions, or content behind an unclicked “Load more” control are not automatically opened.

Choose **Capture main page** when only the outer document is needed.

## PDF output

- Output is an image-based PDF made from actual browser screenshots.
- Long sections continue across pages at a consistent readable scale.
- A4 and US Letter paper, with portrait or landscape orientation, are supported.
- Horizontal scrolling is captured where the region can be reached; wide content may be easier to read in landscape.
- Screenshot text is not converted into a searchable text layer. The preview should be checked for the last row or paragraph you expected to capture.

## Capture settings

**Wait after scrolling** gives images, lazy-loaded rows, and animations time to settle. Use the slower settings when rows appear late or the page changes as it scrolls.

**Avoid repeated floating headers** temporarily hides suitable small fixed or sticky elements after the first capture tile. Large application containers are preserved. If the page loses important content, turn this option off and try again.

**Capture limit** bounds the total number of screenshot tiles across all sections in a capture. The default is 250 screenshots; the popup also offers 100 and 500. Endless feeds need a limit. A capture that reaches its limit or is stopped may be incomplete; review its status and warnings before exporting.

The extension restores scroll positions and temporary style changes after capture. Use **Stop and keep captured pages** in the popup to interrupt a long capture. Keep the original page open until restoration finishes.

## Embedded frames

The extension can inject its capture helper into permitted HTTP and HTTPS frame documents, including frames on a different origin from the main page. It matches those frame documents to their visible iframe elements so the screenshot can be cropped to the right screen area.

The host permissions requested during installation are needed for those cross-origin frames. Chrome's **Site access** controls can restrict access. If an expected frame is missing, check the extension's access to both the main site and its embedded-content site, then rescan.

Frame access is subject to Chrome's restrictions. A frame that cannot be inspected is reported instead of being silently treated as a complete capture.

## Privacy and storage

- Screenshots and PDF generation stay in the browser on your computer.
- The extension contains no analytics, remote services, or upload endpoint.
- It starts scanning or capturing when you use its controls; there is no automatic capture on page load.
- Captures are saved in the extension's local browser storage so the results page can open them again.
- Use the result viewer's delete controls to remove captures. Removing the extension also removes its own stored data.
- Exported PDFs remain in the download location you choose.

## Limits and troubleshooting

**Chrome pages and built-in PDF viewers:** Chrome settings pages, the Chrome Web Store, browser extension pages, and some internal or protected documents cannot be captured with the normal page helper.

**Closed shadow roots:** Content hidden inside a closed shadow root cannot be discovered by ordinary page scripts. Open shadow roots are scanned.

**Changing content:** Infinite feeds, heavily virtualized lists, animation, video, and continuously changing dashboards can produce missing or repeated content. Increase the scroll wait, pause the page if its own interface allows it, and verify the result. A screenshot capture cannot guarantee a stable snapshot of a page that keeps changing.

**Clipping and overlays:** Complex transforms, very small panels, overlapping dialogs, and fixed overlays can constrain what is visible. Close irrelevant overlays and use the specific-panel picker. The extension does not click site buttons or change your task answers.

**Source tab switched:** Return to the capture tab and let the capture finish. Screenshots must be taken from the intended active tab, so the extension will not intentionally record a different tab instead.

**Missing bottom content:** Check the capture status for a tile limit, cancellation, frame warning, or error. Increase the limit or select the missing panel separately. Use a slower scroll wait for late-loading content.

**After editing or replacing extension files:** Open `chrome://extensions`, click the reload icon on ScrollFrame PDF, then reopen the source page before testing the new version.

## Source files

`manifest.json` is Chrome's extension configuration. `background.js` coordinates capture. `content.js` finds and scrolls page regions. `geometry.js` maps and clips coordinates. `popup.html`, `popup.js`, and `popup.css` provide the controls. `store.js` stores captures locally. `viewer.html`, `viewer.js`, and `viewer.css` display results. `pdf.js` creates the PDF. Icons are in `icons/`.

## Validation

The unpacked extension was tested in Chrome for Testing 131.0.6778.204 against local pages served from two different origins. The checks covered independent scroll panels, a nested panel, an embedded frame and its inner panel, horizontal content, lazy-loaded rows, fixed headers, and an open shadow root.

The full capture completed with 9 sections and 45 screenshot tiles. Pixel checks confirmed the final-content markers in every section, including the rightmost edge of the wide table and the rows added during scrolling. Separate checks passed for selected-frame capture, restoring page scroll positions and temporary styles, cancellation with a partial result, the mouse picker, and downloading through the viewer's **Download PDF** button.

Generated PDFs were parsed for page structure and cross-reference offsets, then rendered for visual inspection. The test suite also checked partial exports and horizontal tile alignment. These tests use controlled local fixtures; your website and signed-in session were not accessed or tested.

## Official Chrome installation reference

https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked
