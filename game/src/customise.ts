// Customise preview mode: shared open/browse state between the menu chrome (menu-skin.ts)
// and the gym (game.ts / PlayerModel). Opening zooms the menu camera and hides chrome via
// body.sd-customise; browsing swaps the visible GLB without writing localStorage until Select.
// While a swap is in flight, `loading` is true so the UI can show progress and the mesh stays hidden.

export type CustomiseDetail = {
  open: boolean;
  /** Asset id currently shown (or being loaded) in the 3D view (may be locked — preview only). */
  previewId: string;
  /** Owned skin id that was selected when the panel opened (restore on Back). */
  restoreId: string;
  /** True while a GLB hot-swap is in flight (old mesh already hidden). */
  loading: boolean;
  loadingLabel: string;
};

let open = false;
let previewId = "";
let restoreId = "";
let loading = false;
let loadingLabel = "";

export function isCustomiseOpen() {
  return open;
}

export function customisePreviewId() {
  return previewId;
}

export function customiseRestoreId() {
  return restoreId;
}

export function isCustomiseLoading() {
  return loading;
}

export function customiseLoadingLabel() {
  return loadingLabel;
}

function emit() {
  try {
    window.dispatchEvent(
      new CustomEvent<CustomiseDetail>("sd-customise", {
        detail: { open, previewId, restoreId, loading, loadingLabel },
      }),
    );
  } catch {
    /* no window */
  }
}

/** Enter preview: body class, camera zoom, show overlay. `ownedId` is restored on Back. */
export function openCustomise(ownedId: string, startId = ownedId) {
  open = true;
  restoreId = ownedId;
  previewId = startId;
  loading = false;
  loadingLabel = "";
  try {
    document.body.classList.add("sd-customise");
  } catch {}
  emit();
}

/** Leave preview: clear body class; caller restores the 3D model to restoreId if needed. */
export function closeCustomise() {
  if (!open) return;
  open = false;
  loading = false;
  loadingLabel = "";
  try {
    document.body.classList.remove("sd-customise");
  } catch {}
  emit();
}

/** Browse to another skin id (3D preview). Does not persist. */
export function setCustomisePreview(id: string) {
  if (previewId === id) return;
  previewId = id;
  emit();
}

/** Gym reports swap progress so the customise chrome can show a loading indicator. */
export function setCustomiseLoading(on: boolean, label = "") {
  loading = on;
  loadingLabel = on ? label || "Loading…" : "";
  emit();
}
