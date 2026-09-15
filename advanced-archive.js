(() => {
  "use strict";

  let libarchivePromise = null;

  function loadLibarchive() {
    if (!libarchivePromise) {
      libarchivePromise = import("./vendor/libarchive.js")
        .then(({ Archive }) => {
          Archive.init({
            workerUrl: new URL("./vendor/libarchive-worker.js", document.baseURI).href,
          });
          return Archive;
        })
        .catch((error) => {
          libarchivePromise = null;
          throw error;
        });
    }
    return libarchivePromise;
  }

  async function open(file) {
    const Archive = await loadLibarchive();
    return Archive.open(file);
  }

  globalThis.LightPressureAdvanced = { open };
})();
