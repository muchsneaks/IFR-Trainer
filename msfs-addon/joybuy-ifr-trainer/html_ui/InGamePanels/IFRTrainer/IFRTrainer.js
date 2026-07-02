/**
 * IFR Trainer — MSFS in-game toolbar panel.
 *
 * Thin wrapper that shows the IFR Trainer moving map (served by the IFR
 * Trainer desktop app at http://localhost:<PORT>) inside an MSFS toolbar
 * panel. Because the map is served over localhost, the in-sim panel and the
 * desktop window share the same aircraft position, flight track and navdata.
 *
 * If you run the app on a different port, change PANEL_URL below to match.
 */

// The map is opened with ?embedded=1 so the UI uses the compact in-panel
// layout (side controls collapsed, map maximised).
const PANEL_URL = 'http://localhost:8642/?embedded=1';

class IngamePanelIFRTrainer extends TemplateElement {
    constructor() {
        super();
        this.panelActive = false;
        this.ingameUi = null;
        this.iframeElement = null;
        this.offlineElement = null;
        this.loadTimer = null;
    }

    connectedCallback() {
        super.connectedCallback();

        this.ingameUi = this.querySelector('#IFRTrainer');
        this.iframeElement = this.querySelector('#IFRTrainerIframe');
        this.offlineElement = this.querySelector('#IFRTrainerOffline');

        this.ingameUi.addEventListener('panelActive', () => {
            this.panelActive = true;
            this.showMap();
        });

        this.ingameUi.addEventListener('panelInactive', () => {
            this.panelActive = false;
            this.hideMap();
        });
    }

    showMap() {
        if (!this.iframeElement) return;
        // Show an "offline" hint until the page actually loads; if the app is
        // not running the iframe onload never fires and the hint stays up.
        if (this.offlineElement) this.offlineElement.style.display = 'flex';

        this.iframeElement.onload = () => {
            if (this.offlineElement) this.offlineElement.style.display = 'none';
        };
        // Cache-bust so a previously failed load retries cleanly.
        this.iframeElement.src = PANEL_URL + '&t=' + Date.now();
    }

    hideMap() {
        if (!this.iframeElement) return;
        // Clear the src so the map's WebSocket disconnects while the panel is
        // closed (saves resources; it reconnects instantly when reopened).
        this.iframeElement.onload = null;
        this.iframeElement.src = '';
        if (this.offlineElement) this.offlineElement.style.display = 'none';
    }
}

window.customElements.define('ingamepanel-ifrtrainer', IngamePanelIFRTrainer);
checkAutoload();
