'use strict';
'require view';
'require fs';
'require poll';

// Status -> CPU Load: per-core CPU usage from /proc/stat and the NSS core load
// reported by the NSS firmware, sampled every INTERVAL seconds while the page
// is open. Nothing runs or is stored on the router between visits: the chart
// lives in this browser tab and is gone when it closes.

var STAT = '/proc/stat',
    NSS_LOAD = '/sys/kernel/debug/qca-nss-drv/stats/cpu_load_ubi',
    INTERVAL = 2,
    POINTS = 90,
    COLORS = [ '#2196f3', '#ff9800', '#4caf50', '#e91e63', '#9c27b0', '#795548' ],
    SVGNS = 'http://www.w3.org/2000/svg';

document.head.append(E('style', { 'type': 'text/css' }, [ `
.cpu-live-chart { width: 100%; height: 220px; display: block; border: 1px solid var(--border-color-medium, #ddd); border-radius: 4px }
.cpu-live-chart line { stroke: var(--border-color-medium, #ddd); stroke-width: 1; vector-effect: non-scaling-stroke }
.cpu-live-chart polyline { fill: none; stroke-width: 2; stroke-linejoin: round; vector-effect: non-scaling-stroke }
.cpu-live-axis { display: flex; justify-content: space-between; font-size: 90%; opacity: .7 }
.cpu-live-swatch { display: inline-block; width: 1em; height: .6em; margin-right: .4em; border-radius: 2px; vertical-align: middle }
` ]));

function svg(tag, attrs) {
	var node = document.createElementNS(SVGNS, tag);

	for (var k in attrs)
		node.setAttribute(k, attrs[k]);

	return node;
}

function sum(values) {
	return values.reduce(function(a, b) { return a + b }, 0);
}

// "cpuN user nice system idle iowait irq softirq steal guest guest_nice";
// guest time is already part of user, so only the first eight fields add up.
function parseStat(text) {
	var cores = [];

	(text || '').split(/\n/).forEach(function(line) {
		var m = line.match(/^cpu(\d+)\s+(.+)$/);

		if (!m)
			return;

		var v = m[2].trim().split(/\s+/).slice(0, 8).map(Number);

		cores.push({ id: 'cpu' + m[1], label: _('CPU %d').format(+m[1]),
		             idle: v[3] + v[4], total: sum(v) });
	});

	return cores;
}

// "Core N:" then a "Min Avg Max" header and a "1% 5% 15%" line per core, which
// the firmware averages over one second.
function parseNss(text) {
	var cores = [], core = null;

	(text || '').split(/\n/).forEach(function(line) {
		var m = line.match(/^Core (\d+):/);

		if (m) {
			core = m[1];
			return;
		}

		if (core != null && line.match(/%/)) {
			var v = line.trim().split(/\s+/).map(function(s) { return parseInt(s, 10) });

			cores.push({ id: 'nss' + core, label: _('NSS core %d').format(+core), pct: v[1] });
			core = null;
		}
	});

	return cores;
}

function readAll() {
	return Promise.all([
		L.resolveDefault(fs.read(STAT), ''),
		L.resolveDefault(fs.read(NSS_LOAD), '')
	]);
}

return view.extend({
	load: readAll,

	render: function(data) {
		var prev = {}, history = {}, lines = {}, rows = {}, count = 0,
		    minutes = POINTS * INTERVAL / 60,
		    table = E('table', { 'class': 'table' }),
		    chart = svg('svg', { 'class': 'cpu-live-chart', 'preserveAspectRatio': 'none',
		                         'viewBox': '0 0 %d 100'.format(POINTS - 1) });

		[ 25, 50, 75 ].forEach(function(y) {
			chart.appendChild(svg('line', { 'x1': 0, 'x2': POINTS - 1, 'y1': y, 'y2': y }));
		});

		function track(id, label) {
			if (history[id])
				return;

			var color = COLORS[count++ % COLORS.length];

			history[id] = [];
			lines[id] = chart.appendChild(svg('polyline', { 'stroke': color }));
			rows[id] = {
				bar: E('div', { 'style': 'width:0%' }),
				value: E('td', { 'class': 'td right', 'style': 'width:5em' }, [ '-' ])
			};

			table.appendChild(E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left', 'style': 'width:10em' }, [
					E('span', { 'class': 'cpu-live-swatch', 'style': 'background:' + color }),
					label
				]),
				E('td', { 'class': 'td' }, [ E('div', { 'class': 'cbi-progressbar' }, [ rows[id].bar ]) ]),
				rows[id].value
			]));
		}

		function push(id, pct) {
			var h = history[id];

			pct = Math.max(0, Math.min(100, pct));
			h.push(pct);

			if (h.length > POINTS)
				h.shift();

			rows[id].bar.style.width = '%.1f%%'.format(pct);
			rows[id].value.textContent = '%.0f%%'.format(pct);
			lines[id].setAttribute('points', h.map(function(v, i) {
				return '%d,%.1f'.format(POINTS - h.length + i, 100 - v);
			}).join(' '));
		}

		function update(data) {
			parseStat(data[0]).forEach(function(c) {
				var p = prev[c.id];

				track(c.id, c.label);
				prev[c.id] = c;

				if (p && c.total > p.total)
					push(c.id, 100 * (1 - (c.idle - p.idle) / (c.total - p.total)));
			});

			parseNss(data[1]).forEach(function(c) {
				track(c.id, c.label);
				push(c.id, c.pct);
			});
		}

		update(data);
		poll.add(function() { return readAll().then(update) }, INTERVAL);

		return E([], [
			E('h2', {}, [ _('CPU Load') ]),
			E('div', { 'class': 'cbi-map-descr' }, [
				_('Per-core CPU usage and the NSS core load, sampled every %d seconds while this page is open. Nothing is recorded on the router.').format(INTERVAL)
			]),
			table,
			chart,
			E('div', { 'class': 'cpu-live-axis' }, [
				E('span', {}, [ _('%d minutes ago').format(minutes) ]),
				E('span', {}, [ _('grid: 25 / 50 / 75 %') ]),
				E('span', {}, [ _('now') ])
			])
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
