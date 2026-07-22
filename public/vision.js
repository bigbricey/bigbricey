(function () {
  "use strict";

  const METRICS = [
    "kcal",
    "protein",
    "fat",
    "carbs",
    "fiber",
    "sugars",
    "potassium",
    "magnesium",
    "sodium",
  ];
  const MODE_COPY = {
    meal: {
      user: "Meal photo",
      working: "Looking closely at the foods and portion sizes…",
      alt: "Meal selected for nutrition analysis",
    },
    label: {
      user: "Nutrition label photo",
      working: "Reading the printed serving and nutrition values…",
      alt: "Nutrition Facts label selected for analysis",
    },
    barcode: {
      user: "Barcode photo",
      working: "Reading the code and checking exact product databases…",
      alt: "Product barcode selected for lookup",
    },
  };

  let adapter = null;
  let initialized = false;
  let busy = false;
  let pendingMode = null;

  function number(value) {
    if (value == null || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function rounded(value, digits = 1) {
    const scale = 10 ** digits;
    return Math.round(Number(value) * scale) / scale;
  }

  function displayNumber(value, digits = 1) {
    const parsed = number(value);
    if (parsed == null) return "—";
    return rounded(parsed, digits).toLocaleString(undefined, {
      maximumFractionDigits: digits,
    });
  }

  function dataUrlBytes(value) {
    const base64 = String(value || "").split(",")[1] || "";
    return Math.floor((base64.length * 3) / 4);
  }

  function fileDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("I couldn't open that photo."));
      reader.readAsDataURL(file);
    });
  }

  async function imageSource(file) {
    if (typeof createImageBitmap === "function") {
      try {
        return await createImageBitmap(file, { imageOrientation: "from-image" });
      } catch {
        /* use an HTML image fallback */
      }
    }
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.decoding = "async";
      image.src = url;
      await image.decode();
      return image;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function compressPhoto(file, mode) {
    if (!file?.type?.match(/^image\/(?:jpeg|png|webp)$/i)) {
      throw new Error("Choose a JPEG, PNG, or WebP photo.");
    }
    const source = await imageSource(file);
    const sourceWidth = Number(source.width || source.naturalWidth);
    const sourceHeight = Number(source.height || source.naturalHeight);
    if (!sourceWidth || !sourceHeight) throw new Error("I couldn't read that image.");

    const maxSide = mode === "meal" ? 1_600 : 2_200;
    const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("This browser couldn't prepare the photo.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    if (typeof source.close === "function") source.close();

    let quality = mode === "label" || mode === "barcode" ? 0.9 : 0.86;
    let result = canvas.toDataURL("image/jpeg", quality);
    while (dataUrlBytes(result) > 2_500_000 && quality > 0.48) {
      quality -= 0.08;
      result = canvas.toDataURL("image/jpeg", quality);
    }
    if (dataUrlBytes(result) > 2_900_000) {
      throw new Error("That photo is still too large. Crop closer and try again.");
    }
    return result;
  }

  async function detectBarcode(file) {
    if (typeof BarcodeDetector !== "function") return null;
    let source = null;
    try {
      const supported = typeof BarcodeDetector.getSupportedFormats === "function"
        ? await BarcodeDetector.getSupportedFormats()
        : [];
      const desired = ["upc_a", "upc_e", "ean_8", "ean_13", "itf", "code_128"];
      const formats = desired.filter((format) => !supported.length || supported.includes(format));
      const detector = new BarcodeDetector(formats.length ? { formats } : undefined);
      source = await imageSource(file);
      const matches = await detector.detect(source);
      const raw = String(matches?.[0]?.rawValue || "").replace(/\D/g, "");
      return raw || null;
    } catch {
      return null;
    } finally {
      if (typeof source?.close === "function") source.close();
    }
  }

  function previewNode(image, mode) {
    const wrap = document.createElement("figure");
    wrap.className = "vision-preview";
    const img = document.createElement("img");
    img.src = image;
    img.alt = MODE_COPY[mode].alt;
    const caption = document.createElement("figcaption");
    caption.textContent = "Draft only · image not added to your log";
    wrap.append(img, caption);
    return wrap;
  }

  function scaleExtras(extras, factor) {
    if (!extras || typeof extras !== "object" || Array.isArray(extras)) return extras;
    const copy = { ...extras };
    if (extras.nutrients && typeof extras.nutrients === "object") {
      copy.nutrients = {};
      for (const [key, value] of Object.entries(extras.nutrients)) {
        copy.nutrients[key] = number(value) == null ? value : rounded(Number(value) * factor);
      }
    }
    if (number(extras.net_carbs) != null) {
      copy.net_carbs = rounded(Number(extras.net_carbs) * factor);
    }
    return copy;
  }

  function scaleItemRow(item, quantity = item?.proposed_quantity) {
    const base = number(item?.base_quantity);
    const selected = number(quantity);
    if (!item?.row || base == null || base <= 0 || selected == null || selected <= 0) {
      return null;
    }
    const factor = selected / base;
    const row = { ...item.row };
    for (const key of METRICS) {
      if (number(item.row[key]) != null) row[key] = rounded(Number(item.row[key]) * factor);
      else delete row[key];
    }
    if (number(item.row.grams) != null) row.grams = rounded(Number(item.row.grams) * factor);
    row.extras = scaleExtras(item.row.extras, factor);
    row.label = (
      item.quantity_kind === "servings"
        ? `${displayNumber(selected, 2)} serving${selected === 1 ? "" : "s"} ${item.name}`
        : `${displayNumber(selected, 1)} g ${item.name}`
    ).slice(0, 300);
    return row;
  }

  function confidenceLabel(value) {
    if (value === "high") return "High confidence";
    if (value === "medium") return "Medium confidence";
    return "Low confidence";
  }

  function metricStrip(item, quantity) {
    const row = scaleItemRow(item, quantity);
    const strip = document.createElement("div");
    strip.className = "vision-macros";
    const values = [
      ["kcal", row?.kcal, ""],
      ["protein", row?.protein, "g"],
      ["fat", row?.fat, "g"],
      ["carbs", row?.carbs, "g"],
    ];
    for (const [label, value, unit] of values) {
      const cell = document.createElement("span");
      const strong = document.createElement("strong");
      strong.textContent = value == null ? "—" : `${displayNumber(value, label === "kcal" ? 0 : 1)}${unit}`;
      const small = document.createElement("small");
      small.textContent = label;
      cell.append(strong, small);
      strip.appendChild(cell);
    }
    return strip;
  }

  function sourceNode(item) {
    const line = document.createElement("div");
    line.className = "vision-source";
    const label = document.createElement("span");
    label.textContent = item.source_label || "Nutrition source";
    line.appendChild(label);
    if (item.source_url) {
      const link = document.createElement("a");
      link.href = item.source_url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "View source";
      line.appendChild(link);
    }
    return line;
  }

  function reviewCard(data, context) {
    const card = document.createElement("section");
    card.className = "vision-review";
    card.setAttribute("aria-label", "Photo nutrition draft");
    window.BBProductEvents?.record("photo_review_opened", {
      metadata: { kind: data.mode || "meal" },
    });

    const header = document.createElement("div");
    header.className = "vision-review-head";
    const eyebrow = document.createElement("strong");
    eyebrow.textContent = "PHOTO DRAFT · NOT LOGGED";
    const model = document.createElement("span");
    model.textContent = data.mode === "meal" ? "portion estimate" : data.mode === "label" ? "label read" : "exact lookup";
    header.append(eyebrow, model);

    const summary = document.createElement("p");
    summary.className = "vision-review-summary";
    summary.textContent = data.summary || "Review this draft before logging.";
    card.append(header, summary);

    const drafts = (Array.isArray(data.items) ? data.items : []).map((item) => ({
      ...item,
      selected: item.status === "ready" && number(item.proposed_quantity) > 0,
      quantity: number(item.proposed_quantity),
      controls: {},
    }));

    const itemList = document.createElement("div");
    itemList.className = "vision-items";
    card.appendChild(itemList);

    const actions = document.createElement("div");
    actions.className = "vision-actions";
    const logButton = document.createElement("button");
    logButton.type = "button";
    logButton.className = "vision-log-btn";
    const discardButton = document.createElement("button");
    discardButton.type = "button";
    discardButton.className = "vision-discard-btn";
    discardButton.textContent = "Discard draft";
    const status = document.createElement("div");
    status.className = "vision-action-status";
    status.setAttribute("role", "status");

    function refreshAction() {
      const chosen = drafts.filter(
        (draft) => draft.selected && scaleItemRow(draft, draft.quantity)
      );
      logButton.disabled = !chosen.length || card.classList.contains("is-saving");
      logButton.textContent = chosen.length
        ? `Log ${chosen.length} item${chosen.length === 1 ? "" : "s"}`
        : "Choose an item to log";
    }

    for (const draft of drafts) {
      const section = document.createElement("article");
      section.className = `vision-item is-${draft.status || "unresolved"}`;

      const top = document.createElement("div");
      top.className = "vision-item-top";
      const choose = document.createElement("input");
      choose.type = "checkbox";
      choose.checked = draft.selected;
      choose.disabled = draft.status === "unresolved";
      choose.setAttribute("aria-label", `Include ${draft.name || "food"} in the log`);
      const names = document.createElement("div");
      names.className = "vision-item-names";
      const name = document.createElement("strong");
      name.textContent = draft.name || "Unidentified food";
      const identified = document.createElement("span");
      identified.textContent = draft.identified_as || "No verified nutrition match";
      names.append(name, identified);
      const confidence = document.createElement("span");
      confidence.className = `vision-confidence is-${draft.confidence || "low"}`;
      confidence.textContent = confidenceLabel(draft.confidence);
      top.append(choose, names, confidence);
      section.appendChild(top);

      let macroMount = null;
      if (draft.status !== "unresolved") {
        const quantityRow = document.createElement("div");
        quantityRow.className = "vision-quantity";
        const label = document.createElement("label");
        label.textContent = draft.quantity_label || "Amount";
        const input = document.createElement("input");
        input.type = "number";
        input.inputMode = "decimal";
        input.min = draft.quantity_kind === "servings" ? "0.01" : "1";
        input.max = draft.quantity_kind === "servings" ? "100" : "10000";
        input.step = draft.quantity_kind === "servings" ? "0.25" : "1";
        input.value = draft.quantity == null ? "" : String(draft.quantity);
        input.placeholder = draft.quantity_kind === "servings" ? "1" : "grams";
        label.appendChild(input);
        quantityRow.appendChild(label);
        if (number(draft.min_quantity) != null && number(draft.max_quantity) != null) {
          const range = document.createElement("span");
          range.textContent = `Likely ${displayNumber(draft.min_quantity, 0)}–${displayNumber(draft.max_quantity, 0)} g`;
          quantityRow.appendChild(range);
        }
        section.appendChild(quantityRow);
        macroMount = metricStrip(draft, draft.quantity);
        section.appendChild(macroMount);

        input.addEventListener("input", () => {
          draft.quantity = number(input.value);
          if (draft.quantity && !choose.checked) choose.checked = true;
          draft.selected = choose.checked && Boolean(draft.quantity);
          const replacement = metricStrip(draft, draft.quantity);
          macroMount.replaceWith(replacement);
          macroMount = replacement;
          refreshAction();
        });
      }

      section.appendChild(sourceNode(draft));
      if (draft.note) {
        const note = document.createElement("p");
        note.className = "vision-item-note";
        note.textContent = draft.note;
        section.appendChild(note);
      }
      choose.addEventListener("change", () => {
        draft.selected = choose.checked;
        refreshAction();
      });
      draft.controls = { choose, section };
      itemList.appendChild(section);
    }

    if (Array.isArray(data.questions) && data.questions.length) {
      const questions = document.createElement("div");
      questions.className = "vision-questions";
      for (const question of data.questions.slice(0, 3)) {
        const line = document.createElement("p");
        line.textContent = question;
        questions.appendChild(line);
      }
      card.appendChild(questions);
    }

    const privacy = document.createElement("p");
    privacy.className = "vision-privacy";
    privacy.textContent =
      data.privacy || "The image is analyzed for this draft and is not added to your log.";
    card.appendChild(privacy);

    logButton.addEventListener("click", async () => {
      if (!adapter.contextMatches(context)) {
        status.textContent = "The day or conversation changed. Scan the photo again here.";
        status.classList.add("is-error");
        return;
      }
      const selected = drafts.filter(
        (draft) => draft.selected && scaleItemRow(draft, draft.quantity)
      );
      const proposedRows = selected.map((draft) => scaleItemRow(draft, draft.quantity));
      if (!proposedRows.length) return;
      card.classList.add("is-saving");
      status.classList.remove("is-error");
      status.textContent = "Saving to the selected day…";
      refreshAction();
      discardButton.disabled = true;
      const result = await adapter.commitRows(proposedRows, context);
      if (!result?.ok) {
        card.classList.remove("is-saving");
        discardButton.disabled = false;
        status.classList.add("is-error");
        status.textContent = result?.message || "Nothing was added. Try again.";
        refreshAction();
        return;
      }

      card.classList.remove("is-saving");
      card.classList.add("is-committed");
      eyebrow.textContent = "LOGGED · VERIFIED SAVE";
      model.textContent = context.day;
      status.textContent = `Saved ${proposedRows.length} item${proposedRows.length === 1 ? "" : "s"} to ${context.day}.`;
      logButton.textContent = "Logged";
      logButton.disabled = true;
      discardButton.disabled = true;
      card.querySelectorAll("input, button").forEach((control) => {
        control.disabled = true;
      });
      window.BBProductEvents?.record("photo_log_confirmed", {
        numeric_value: proposedRows.length,
        metadata: { kind: data.mode || "meal", source: "review" },
      });

      if (data.mode === "meal") {
        const corrections = selected
          .filter((draft) => {
            const original = number(draft.original_estimated_grams);
            return original && Math.abs(Number(draft.quantity) / original - 1) >= 0.05;
          })
          .map((draft) => ({
            food_name: draft.name,
            estimated_grams: draft.original_estimated_grams,
            final_grams: draft.quantity,
          }));
        if (corrections.length) {
          fetch("/api/vision", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ op: "remember_correction", corrections }),
          }).catch(() => {});
        }
      }
    });

    discardButton.addEventListener("click", () => {
      card.closest(".chat-bubble")?.remove();
    });

    actions.append(logButton, discardButton);
    card.append(actions, status);
    refreshAction();
    return card;
  }

  function setBusy(value) {
    busy = Boolean(value);
    const button = document.getElementById("photoBtn");
    if (button) {
      button.disabled = busy;
      button.classList.toggle("is-busy", busy);
      button.setAttribute("aria-label", busy ? "Analyzing food photo" : "Add a food photo");
    }
  }

  function setTray(open) {
    const tray = document.getElementById("photoModeTray");
    const button = document.getElementById("photoBtn");
    if (!tray || !button) return;
    tray.hidden = !open;
    button.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) tray.querySelector("[data-vision-mode]")?.focus();
  }

  async function processPhoto(file, mode) {
    const context = adapter.getContext();
    if (!context?.account) return;
    setBusy(true);
    let thinking = null;
    try {
      const nativeBarcode = mode === "barcode" ? await detectBarcode(file) : null;
      const image = await compressPhoto(file, mode);
      if (!adapter.contextMatches(context)) return;
      adapter.appendChat("user", MODE_COPY[mode].user, false, {
        attachment: previewNode(image, mode),
      });
      thinking = adapter.appendChat("bot", MODE_COPY[mode].working, false, {
        thinking: true,
      });
      const response = await fetch("/api/vision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          op: "analyze",
          mode,
          image,
          barcode: nativeBarcode,
          date: context.day,
          conversation_id: context.conversationId,
        }),
      });
      const data = await response.json().catch(() => ({}));
      thinking?.remove();
      thinking = null;
      if (!adapter.contextMatches(context)) return;
      if (!response.ok) throw new Error(data.message || "I couldn't analyze that photo.");
      const attachment = reviewCard(data, context);
      adapter.appendChat("bot", "Here’s the draft I made from the photo.", false, {
        attachment,
      });
    } catch (error) {
      thinking?.remove();
      if (adapter.contextMatches(context)) {
        adapter.appendChat(
          "bot",
          error?.message || "I couldn't analyze that photo. Try again with better light.",
          true
        );
      }
    } finally {
      setBusy(false);
    }
  }

  function init(nextAdapter) {
    if (initialized) return;
    adapter = nextAdapter;
    const button = document.getElementById("photoBtn");
    const tray = document.getElementById("photoModeTray");
    const close = document.getElementById("photoModeClose");
    const input = document.getElementById("photoInput");
    if (!button || !tray || !input || !adapter) return;
    initialized = true;

    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!busy) setTray(tray.hidden);
    });
    close?.addEventListener("click", () => setTray(false));
    tray.addEventListener("click", (event) => event.stopPropagation());
    tray.querySelectorAll("[data-vision-mode]").forEach((choice) => {
      choice.addEventListener("click", async () => {
        pendingMode = choice.dataset.visionMode;
        setTray(false);
        await adapter.stopVoice?.();
        input.value = "";
        input.click();
      });
    });
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      const mode = pendingMode;
      pendingMode = null;
      if (file && MODE_COPY[mode]) processPhoto(file, mode);
    });
    document.addEventListener("click", () => setTray(false));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") setTray(false);
    });
  }

  window.BBVision = {
    init,
    scaleItemRow,
    compressPhoto,
  };
})();
