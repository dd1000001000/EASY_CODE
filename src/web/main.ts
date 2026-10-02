import { createApp } from "vue";
import App from "./App.vue";
import "./element-plus-styles.js";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/transcript.css";
import "./styles/markdown.css";
import "./styles/composer.css";
import "./styles/panels.css";
import "./styles/dialogs.css";
import { initTheme } from "./theme.js";

// Before mounting, so a dark page never flashes light.
initTheme();
createApp(App).mount("#app");
