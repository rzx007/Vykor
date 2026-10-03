import { createPluginUiClient, type PluginUiViewSnapshot } from "@vykor/plugins/ui-sdk";
if (window.parent !== window) {
  void createPluginUiClient().then(client => {
    client.onSnapshot((snapshot: PluginUiViewSnapshot) => {
      document.querySelector("#status")!.textContent = String(snapshot.data.count ?? "");
    });
    document.querySelector("#apply")?.addEventListener("click", () => {
      void client.requestAction("apply", { text: "<script>not html</script>" }).then(receipt => {
        document.querySelector("#result")!.textContent = receipt.runId;
      }).catch(error => { document.querySelector("#result")!.textContent = error.code; });
    });
  });
}
