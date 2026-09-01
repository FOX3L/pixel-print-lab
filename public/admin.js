import { createApi } from "./js/admin/api.js";
import { state } from "./js/admin/state.js";
import { initAuth } from "./js/admin/auth.js";
import { initOrders } from "./js/admin/orders.js";
import { initProducts } from "./js/admin/products.js";
import { initColors } from "./js/admin/colors.js";
import { initSettings } from "./js/admin/settings.js";
import { initPix } from "./js/admin/pix.js";

const apiHooks = {};
const api = createApi(apiHooks);

const products = initProducts({ api });
initColors({ api, reloadCatalog: () => products.loadCatalog(state.selectedProductId, true) });
const pix = initPix({ api });
const orders = initOrders({ api, loadPix: pix.loadPix });

const auth = initAuth({
  api,
  onAuthenticated: async () => {
    await products.loadCatalog();
    await orders.loadOrders();
  },
});
apiHooks.onUnauthorized = () => auth.showLogin();

initSettings({ api, onCredentialsSaved: (message) => auth.showLogin(message) });

auth.boot();
