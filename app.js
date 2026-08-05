/* Fuelband — daily activity tracker.
   Fuel points are MET-based: fuel = METs × minutes × 4 (rounded).
   All data lives in localStorage under one key. */

(() => {
  "use strict";

  const STORAGE_KEY = "fuelband.v1";
  const BODY_WEIGHT_KG = 70; // calorie estimate baseline

  // Activity catalog: base METs at moderate intensity, steps per minute where
  // the activity produces meaningful step counts.
  const ACTIVITIES = {
    walk:   { label: "Walking",    met: 3.5,  stepsPerMin: 100 },
    run:    { label: "Running",    met: 9.0,  stepsPerMin: 160 },
    cycle:  { label: "Cycling",    met: 7.0,  stepsPerMin: 0 },
    swim:   { label: "Swimming",   met: 7.0,  stepsPerMin: 0 },
    gym:    { label: "Gym workout", met: 5.5, stepsPerMin: 20 },
    yoga:   { label: "Yoga",       met: 2.8,  stepsPerMin: 0 },
    sports: { label: "Team sports", met: 7.5, stepsPerMin: 90 },
    dance:  { label: "Dancing",    met: 5.0,  stepsPerMin: 80 },
  };
  const INTENSITY_FACTOR = { light: 0.75, moderate: 1.0, intense: 1.3 };

  // ---------- State ----------

  function defaultState() {
    return { goal: 3000, days: {} }; // days: { "YYYY-MM-DD": [{type, mins, intensity, fuel, id}] }
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || typeof parsed.days !== "object") {
        return defaultState();
      }
      return { ...defaultState(), ...parsed };
    } catch {
      return defaultState();
    }
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  let state = loadState();

  // ---------- Date helpers ----------

  function dateKey(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function todayKey() {
    return dateKey(new Date());
  }

  function lastNDays(n) {
    const out = [];
    const now = new Date();
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      out.push(d);
    }
    return out;
  }

  // ---------- Derived values ----------

  function fuelFor(type, mins, intensity) {
    const act = ACTIVITIES[type];
    if (!act) return 0;
    return Math.round(act.met * INTENSITY_FACTOR[intensity] * mins * 4);
  }

  function dayEntries(key) {
    return state.days[key] || [];
  }

  function dayFuel(key) {
    return dayEntries(key).reduce((sum, e) => sum + e.fuel, 0);
  }

  function dayStats(key) {
    let steps = 0, cals = 0, mins = 0;
    for (const e of dayEntries(key)) {
      const act = ACTIVITIES[e.type];
      if (!act) continue;
      const factor = INTENSITY_FACTOR[e.intensity] || 1;
      steps += Math.round(act.stepsPerMin * factor * e.mins);
      cals += Math.round((act.met * factor * 3.5 * BODY_WEIGHT_KG) / 200 * e.mins);
      mins += e.mins;
    }
    return { steps, cals, mins };
  }

  function streak() {
    // Consecutive days (ending today or yesterday) that met the goal.
    let count = 0;
    const d = new Date();
    if (dayFuel(dateKey(d)) < state.goal) d.setDate(d.getDate() - 1);
    while (dayFuel(dateKey(d)) >= state.goal) {
      count++;
      d.setDate(d.getDate() - 1);
    }
    return count;
  }

  // ---------- DOM ----------

  const $ = (id) => document.getElementById(id);
  const fmt = new Intl.NumberFormat();

  function renderHero() {
    const key = todayKey();
    const fuel = dayFuel(key);
    const { steps, cals, mins } = dayStats(key);
    const pct = state.goal > 0 ? fuel / state.goal : 0;

    $("fuel-today").textContent = fmt.format(fuel);
    $("goal-value").textContent = fmt.format(state.goal);
    $("goal-pct").textContent = `${Math.round(pct * 100)}% of goal`;
    $("stat-steps").textContent = fmt.format(steps);
    $("stat-cals").textContent = fmt.format(cals);
    $("stat-mins").textContent = fmt.format(mins);
    $("stat-streak").textContent = fmt.format(streak());

    const circumference = 603.2;
    $("ring-fill").style.strokeDashoffset =
      String(circumference * (1 - Math.min(pct, 1)));
  }

  function renderActivityList() {
    const list = $("activity-list");
    list.innerHTML = "";
    for (const e of dayEntries(todayKey())) {
      const li = document.createElement("li");

      const name = document.createElement("span");
      name.className = "act-name";
      name.textContent = ACTIVITIES[e.type]?.label || e.type;

      const meta = document.createElement("span");
      meta.className = "act-meta";
      meta.textContent = `${e.mins} min · ${e.intensity}`;

      const fuel = document.createElement("span");
      fuel.className = "act-fuel";
      fuel.textContent = fmt.format(e.fuel);

      const del = document.createElement("button");
      del.className = "act-delete";
      del.type = "button";
      del.setAttribute("aria-label", "Delete entry");
      del.textContent = "✕";
      del.addEventListener("click", () => {
        const key = todayKey();
        state.days[key] = dayEntries(key).filter((x) => x.id !== e.id);
        saveState();
        renderAll();
      });

      li.append(name, meta, fuel, del);
      list.appendChild(li);
    }
  }

  // ---------- Weekly chart ----------

  const CHART = { w: 800, h: 260, top: 24, right: 16, bottom: 28, left: 44 };

  function renderChart() {
    const days = lastNDays(7);
    const values = days.map((d) => dayFuel(dateKey(d)));
    const max = Math.max(state.goal, ...values, 1) * 1.1;

    const { w, h, top, right, bottom, left } = CHART;
    const plotW = w - left - right;
    const plotH = h - top - bottom;
    const slot = plotW / 7;
    const barW = Math.min(40, slot - 16);
    const y = (v) => top + plotH * (1 - v / max);

    const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short" });
    const fullFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" });

    let svg = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Fuel earned each of the last seven days">`;

    // Hairline gridlines at 0 / 50 / 100% of goal scale-ish: use 3 ticks
    const ticks = [0, Math.round(max / 2 / 100) * 100, Math.round(max / 100) * 100].filter(
      (v, i, a) => a.indexOf(v) === i
    );
    for (const t of ticks) {
      const ty = y(t);
      svg += `<line x1="${left}" y1="${ty}" x2="${w - right}" y2="${ty}" stroke="#26282a" stroke-width="1"/>`;
      svg += `<text x="${left - 8}" y="${ty + 4}" text-anchor="end" font-size="11" fill="#83867c">${fmt.format(t)}</text>`;
    }

    // Goal line (dashed)
    const gy = y(state.goal);
    svg += `<line x1="${left}" y1="${gy}" x2="${w - right}" y2="${gy}" stroke="#83867c" stroke-width="1" stroke-dasharray="4 4"/>`;
    svg += `<text x="${w - right}" y="${gy - 6}" text-anchor="end" font-size="11" fill="#b9bcae">goal</text>`;

    // Bars: thin, 4px rounded data-end anchored to baseline (rounded top only,
    // via path), today direct-labeled.
    days.forEach((d, i) => {
      const v = values[i];
      const cx = left + slot * i + slot / 2;
      const x0 = cx - barW / 2;
      const isToday = dateKey(d) === todayKey();
      const barTop = y(v);
      const base = top + plotH;
      const height = Math.max(base - barTop, 0);
      const r = Math.min(4, height, barW / 2);
      if (height > 0) {
        svg += `<path d="M ${x0} ${base}
                 L ${x0} ${barTop + r}
                 Q ${x0} ${barTop} ${x0 + r} ${barTop}
                 L ${x0 + barW - r} ${barTop}
                 Q ${x0 + barW} ${barTop} ${x0 + barW} ${barTop + r}
                 L ${x0 + barW} ${base} Z"
                 fill="#79a600" opacity="${isToday ? 1 : 0.65}"/>`;
      }
      if (isToday && v > 0) {
        svg += `<text x="${cx}" y="${barTop - 8}" text-anchor="middle" font-size="12" font-weight="700" fill="#f5f6f2">${fmt.format(v)}</text>`;
      }
      svg += `<text x="${cx}" y="${h - 8}" text-anchor="middle" font-size="12" fill="${isToday ? "#f5f6f2" : "#83867c"}"${isToday ? ' font-weight="700"' : ""}>${dayFmt.format(d)}</text>`;
      // Full-height invisible hit target for hover (bigger than the mark)
      svg += `<rect class="hit" data-i="${i}" x="${left + slot * i}" y="${top}" width="${slot}" height="${plotH}" fill="transparent"/>`;
    });

    // Baseline
    svg += `<line x1="${left}" y1="${top + plotH}" x2="${w - right}" y2="${top + plotH}" stroke="#3a3d40" stroke-width="1"/>`;
    svg += `</svg>`;

    const wrap = $("chart-wrap");
    wrap.innerHTML = svg;

    // Tooltip layer
    const tooltip = $("tooltip");
    wrap.querySelectorAll(".hit").forEach((hit) => {
      hit.addEventListener("mousemove", (ev) => {
        const i = Number(hit.dataset.i);
        tooltip.hidden = false;
        tooltip.innerHTML =
          `<div class="tt-label">${fullFmt.format(days[i])}</div>` +
          `<div><strong>${fmt.format(values[i])}</strong> fuel · goal ${fmt.format(state.goal)}</div>`;
        tooltip.style.left = `${ev.clientX + 14}px`;
        tooltip.style.top = `${ev.clientY - 10}px`;
      });
      hit.addEventListener("mouseleave", () => {
        tooltip.hidden = true;
      });
    });

    renderChartTable(days, values);
  }

  function renderChartTable(days, values) {
    const fullFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" });
    const rows = days
      .map((d, i) => {
        const met = values[i] >= state.goal ? " ✓" : "";
        return `<tr><td>${fullFmt.format(d)}</td><td>${fmt.format(values[i])}${met}</td></tr>`;
      })
      .join("");
    $("chart-table").innerHTML =
      `<table><thead><tr><th>Day</th><th>Fuel</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  // ---------- Wiring ----------

  function renderAll() {
    renderHero();
    renderActivityList();
    renderChart();
  }

  function init() {
    // Populate activity select
    const select = $("activity-type");
    for (const [key, act] of Object.entries(ACTIVITIES)) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = act.label;
      select.appendChild(opt);
    }

    $("today-date").textContent = new Intl.DateTimeFormat(undefined, {
      weekday: "long", month: "long", day: "numeric",
    }).format(new Date());

    $("log-form").addEventListener("submit", (ev) => {
      ev.preventDefault();
      const type = select.value;
      const mins = Math.max(1, Math.min(600, Number($("activity-mins").value) || 0));
      const intensity = $("activity-intensity").value;
      if (!ACTIVITIES[type] || mins <= 0) return;
      const key = todayKey();
      if (!state.days[key]) state.days[key] = [];
      state.days[key].push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type, mins, intensity,
        fuel: fuelFor(type, mins, intensity),
      });
      saveState();
      renderAll();
    });

    $("edit-goal").addEventListener("click", () => {
      const input = prompt("Daily fuel goal:", String(state.goal));
      if (input === null) return;
      const goal = Math.round(Number(input));
      if (!Number.isFinite(goal) || goal < 100 || goal > 100000) return;
      state.goal = goal;
      saveState();
      renderAll();
    });

    $("toggle-table").addEventListener("click", () => {
      const table = $("chart-table");
      const wrap = $("chart-wrap");
      const showTable = table.hidden;
      table.hidden = !showTable;
      wrap.hidden = showTable;
      $("toggle-table").setAttribute("aria-pressed", String(showTable));
      $("toggle-table").textContent = showTable ? "Chart view" : "Table view";
    });

    renderAll();
  }

  init();
})();
