/*
 * OctoScheduler - file d'attente d'impressions
 */
$(function () {
    var PLUGIN = "octoscheduler";
    var DND_MIME = "application/x-octoscheduler";

    function pad(n) {
        return (n < 10 ? "0" : "") + n;
    }

    function startOfDay(d) {
        var x = new Date(d);
        x.setHours(0, 0, 0, 0);
        return x.getTime();
    }

    function formatClock(ts, now) {
        if (ts === undefined || ts === null) return "?";
        var d = new Date(ts);
        var hm = pad(d.getHours()) + ":" + pad(d.getMinutes());
        var days = Math.round((startOfDay(ts) - startOfDay(now || Date.now())) / 86400000);
        if (days === 0) return hm;
        if (days === 1) return "demain " + hm;
        var wd = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."][d.getDay()];
        return wd + " " + pad(d.getDate()) + "/" + pad(d.getMonth() + 1) + " " + hm;
    }

    function formatDuration(seconds) {
        if (seconds === undefined || seconds === null || isNaN(seconds)) return "?";
        seconds = Math.max(0, Math.round(seconds));
        var d = Math.floor(seconds / 86400);
        var h = Math.floor((seconds % 86400) / 3600);
        var m = Math.floor((seconds % 3600) / 60);
        if (d) return d + "j " + h + "h" + pad(m);
        if (h) return h + "h" + pad(m);
        if (m) return m + " min";
        return seconds + " s";
    }

    var SOURCE_LABELS = {
        history: "moyenne des impressions précédentes",
        slicer: "estimation du slicer",
        octoprint: "estimation OctoPrint / PrintTimeGenius"
    };

    function OctoSchedulerViewModel(parameters) {
        var self = this;

        self.loginState = parameters[0];
        self.printerState = parameters[1];
        self.files = parameters[2];
        self.access = parameters[3];
        self.settingsVM = parameters[4];

        self.queue = ko.observableArray([]);
        self.current = ko.observable(null);
        self.history = ko.observableArray([]);
        self.changeoverMinutes = ko.observable(5);
        self.nightStart = ko.observable(22);
        self.nightEnd = ko.observable(7);
        self.readyActions = ko.observableArray([]);
        self.loaded = ko.observable(false);
        self.busy = ko.observable(false);
        self.now = ko.observable(Date.now());

        self.availableFiles = ko.observableArray([]);
        self.fileFilter = ko.observable("");
        self.showAddPanel = ko.observable(false);
        self.showHistory = ko.observable(false);

        // état du glisser-déposer
        self.dragging = null;
        self.dropIndex = ko.observable(null);
        self.dropTarget = ko.observable(null); // "timeline" | "list"

        setInterval(function () {
            self.now(Date.now());
        }, 15000);

        // ------------------------------------------------------- permissions

        self.hasPerm = function (key) {
            var perms = self.access.permissions;
            var perm = perms && perms[key];
            if (!perm) return self.loginState.isAdmin();
            return self.loginState.hasPermission(perm);
        };
        self.canManage = ko.pureComputed(function () {
            self.loginState.isUser(); // dépendance
            return self.hasPerm("PLUGIN_OCTOSCHEDULER_MANAGE");
        });
        self.canPrint = ko.pureComputed(function () {
            self.loginState.isUser();
            return self.hasPerm("PRINT");
        });

        // ------------------------------------------------------------- API

        var base = function () {
            return OctoPrint.getBlueprintUrl(PLUGIN);
        };

        self.applyState = function (state) {
            if (!state) return;
            self.queue(state.queue || []);
            self.current(state.current || null);
            self.history(state.history || []);
            self.changeoverMinutes(state.changeover_minutes || 0);
            self.nightStart(state.night_start);
            self.nightEnd(state.night_end);
            self.readyActions(state.ready_actions || []);
            self.loaded(true);
        };

        self.request = function (method, url, data) {
            self.busy(true);
            var promise =
                method === "GET"
                    ? OctoPrint.get(base() + url)
                    : OctoPrint.postJson(base() + url, data || {});
            return promise
                .done(self.applyState)
                .fail(function (xhr) {
                    var msg =
                        (xhr && xhr.responseJSON && (xhr.responseJSON.error || xhr.responseJSON.description)) ||
                        (xhr && xhr.statusText) ||
                        "Erreur inconnue";
                    new PNotify({ title: "Planificateur", text: msg, type: "error", hide: true });
                    self.refresh();
                })
                .always(function () {
                    self.busy(false);
                });
        };

        self.refresh = function () {
            return OctoPrint.get(base() + "state").done(self.applyState);
        };

        self.addPaths = function (paths, index) {
            var data = { paths: paths };
            if (index !== undefined && index !== null) data.index = index;
            return self.request("POST", "queue/add", data).done(function () {
                new PNotify({
                    title: "Planificateur",
                    text:
                        paths.length > 1
                            ? paths.length + " fichiers ajoutés à la file"
                            : _.escape(paths[0].split("/").pop()) + " ajouté à la file",
                    type: "success",
                    hide: true,
                    delay: 2500
                });
            });
        };

        self.removeItem = function (item) {
            self.queue.remove(function (i) {
                return i.id === item.id;
            });
            self.request("POST", "queue/remove", { id: item.id });
        };

        self.clearQueue = function () {
            if (!self.queue().length) return;
            showConfirmationDialog({
                title: "Vider la file",
                message: "Retirer les " + self.queue().length + " fichiers de la file d'attente ?",
                proceed: "Vider",
                onproceed: function () {
                    self.request("POST", "queue/clear");
                }
            });
        };

        self.reorder = function (ids) {
            var byId = {};
            _.each(self.queue(), function (i) {
                byId[i.id] = i;
            });
            self.queue(
                _.filter(
                    _.map(ids, function (id) {
                        return byId[id];
                    }),
                    _.identity
                )
            );
            self.request("POST", "queue/reorder", { order: ids });
        };

        self.move = function (item, delta) {
            var ids = _.pluck(self.queue(), "id");
            var i = ids.indexOf(item.id);
            var j = i + delta;
            if (i < 0 || j < 0 || j >= ids.length) return;
            ids.splice(i, 1);
            ids.splice(j, 0, item.id);
            self.reorder(ids);
        };

        self.startNext = function () {
            self.request("POST", "start");
        };

        // ----------------------------------------------------- planning

        self.isPrinting = ko.pureComputed(function () {
            return !!(self.printerState.isPrinting() || self.printerState.isPaused());
        });

        self.currentRemaining = ko.pureComputed(function () {
            if (!self.isPrinting()) return null;
            var progress = self.printerState.progress() || 0;
            var left = self.printerState.printTimeLeft();
            // OctoPrint renvoie parfois 0 sans estimation réelle : on l'ignore tant que l'impression n'est pas finie
            if (left !== undefined && left !== null && (left > 0 || progress >= 99)) return left;
            var elapsed = self.printerState.printTime() || 0;
            var est = self.printerState.estimatedPrintTime();
            var cur = self.current();
            if (!est && cur && cur.estimated_time) est = cur.estimated_time;
            if (est && est > elapsed) return est - elapsed;
            return null;
        });

        // Heure courante arrondie à la minute : évite de redessiner en continu
        self.nowMin = ko.pureComputed(function () {
            return Math.floor(self.now() / 60000) * 60000;
        });

        // Pendant un glisser-déposer, l'affichage est figé (sinon les éléments
        // déplacés seraient recréés à chaque mise à jour de la progression)
        self.frozen = ko.observable(false);
        var lastSchedule = null;
        var deepEqual = function (a, b) {
            return _.isEqual(a, b);
        };

        // Liste des segments planifiés (impression en cours + file)
        self.schedule = ko.pureComputed(function () {
            if (self.frozen() && lastSchedule) return lastSchedule;
            var now = self.nowMin();

            var out = [];
            var t = now;
            var gap = (self.changeoverMinutes() || 0) * 60000;

            if (self.isPrinting()) {
                var remaining = self.currentRemaining();
                if (remaining !== null) remaining = Math.round(remaining / 60) * 60;
                var cur = self.current() || {};
                var elapsed = Math.round((self.printerState.printTime() || 0) / 60) * 60000;
                var end = remaining !== null ? now + remaining * 1000 : null;
                out.push({
                    kind: "current",
                    id: "__current__",
                    name: cur.name || self.printerState.filename() || "Impression en cours",
                    thumbnail: cur.thumbnail || null,
                    start: now - elapsed,
                    visibleStart: now,
                    end: end,
                    duration: remaining,
                    unknown: remaining === null,
                    progress: Math.floor(self.printerState.progress() || 0),
                    paused: !!self.printerState.isPaused(),
                    time_source: null
                });
                t = (end || now + 3600000) + gap;
            }

            _.each(self.queue(), function (item, idx) {
                var dur = item.estimated_time;
                var unknown = !dur;
                var durMs = (dur || 3600) * 1000;
                out.push(
                    _.extend({}, item, {
                        kind: "queued",
                        index: idx,
                        start: t,
                        visibleStart: t,
                        end: t + durMs,
                        duration: dur,
                        unknown: unknown
                    })
                );
                t = t + durMs + gap;
            });
            lastSchedule = out;
            return out;
        });
        // ne notifier (et donc redessiner) que si le planning a réellement changé
        self.schedule.equalityComparer = deepEqual;

        self.queueEnd = ko.pureComputed(function () {
            var s = self.schedule();
            if (!s.length) return null;
            return s[s.length - 1].end;
        });

        self.totalQueueTime = ko.pureComputed(function () {
            return _.reduce(
                self.queue(),
                function (acc, i) {
                    return acc + (i.estimated_time || 0);
                },
                0
            );
        });

        self.unknownCount = ko.pureComputed(function () {
            return _.filter(self.queue(), function (i) {
                return !i.estimated_time;
            }).length;
        });

        // ------------------------------------------------------ timeline

        var ZOOM_MAX = 2400; // px par heure
        // vue complète par défaut ; on ne peut pas dézoomer au-delà
        self.fitMode = ko.observable(true);
        self.pxPerHourManual = ko.observable(120);
        self.tlWidth = ko.observable(800);

        // bornes temporelles du contenu
        self.tlRange = ko.pureComputed(function () {
            var now = self.nowMin();
            var start = now;
            var end = now + 2 * 3600000;
            _.each(self.schedule(), function (s) {
                if (s.start < start) start = s.start;
                var e = s.end || s.visibleStart + 3600000;
                if (e > end) end = e;
            });
            start = Math.max(start, now - 24 * 3600000) - 10 * 60000;
            return { start: start, end: end, now: now };
        });
        self.tlRange.equalityComparer = deepEqual;

        // échelle qui fait tenir tout le planning dans la largeur = zoom minimal
        self.fitPxPerHour = ko.pureComputed(function () {
            var r = self.tlRange();
            var hours = ((r.end - r.start) / 3600000) * 1.04;
            return Math.min(ZOOM_MAX, (self.tlWidth() - 2) / hours);
        });

        self.pxPerHour = ko.pureComputed(function () {
            var fit = self.fitPxPerHour();
            if (self.fitMode()) return fit;
            return Math.max(fit, self.pxPerHourManual());
        });

        self.isFullView = ko.pureComputed(function () {
            return self.pxPerHour() <= self.fitPxPerHour() + 0.01;
        });

        self.timeline = ko.pureComputed(function () {
            var r = self.tlRange();
            var now = r.now;
            var pph = self.pxPerHour();
            var x = function (ts) {
                return ((ts - r.start) / 3600000) * pph;
            };
            var endMargin = self.isFullView() ? 0 : Math.max(40, pph * 0.25);
            var width = Math.max(self.tlWidth() - 2, Math.ceil(x(r.end) + endMargin));
            var viewEnd = r.start + (width / pph) * 3600000;

            var blocks = _.map(self.schedule(), function (s) {
                var left = x(s.start);
                var right = x(s.end || s.visibleStart + 3600000);
                var w = Math.max(3, right - left);
                return _.extend({}, s, {
                    left: left + "px",
                    width: w + "px",
                    sizeClass: w < 36 ? "osch-tiny" : w < 130 ? "osch-narrow" : "",
                    elapsedWidth: s.kind === "current" ? Math.max(0, Math.min(w, x(now) - left)) + "px" : "0",
                    endLabel: s.end ? formatClock(s.end, now) : "?",
                    startLabel: formatClock(s.start, now),
                    durationLabel: (s.unknown ? "~" : "") + formatDuration(s.duration),
                    title:
                        s.name +
                        "\n" +
                        (s.kind === "current" ? "Reste " : "Durée ") +
                        (s.unknown ? "inconnue" : formatDuration(s.duration)) +
                        (s.kind === "current" ? "" : "\nDébut : " + formatClock(s.start, now)) +
                        "\nFin : " +
                        (s.end ? formatClock(s.end, now) : "?")
                });
            });

            // graduations : au moins ~70 px entre deux
            var steps = [0.25, 0.5, 1, 2, 3, 6, 12, 24, 48];
            var step =
                _.find(steps, function (st) {
                    return st * pph >= 70;
                }) || 96;
            var stepMs = step * 3600000;
            var offset = new Date(r.start).getTimezoneOffset() * 60000;
            var first = Math.ceil((r.start - offset) / stepMs) * stepMs + offset;
            var ticks = [];
            for (var ts = first; ts < viewEnd; ts += stepMs) {
                var d = new Date(ts);
                var midnight = d.getHours() === 0 && d.getMinutes() === 0;
                ticks.push({
                    left: x(ts) + "px",
                    label: midnight
                        ? ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."][d.getDay()] + " " + pad(d.getDate())
                        : pad(d.getHours()) + ":" + pad(d.getMinutes()),
                    major: midnight
                });
            }

            // nuits
            var nights = [];
            var ns = self.nightStart(),
                ne = self.nightEnd();
            if (ns !== null && ne !== null && ns !== undefined && ne !== undefined && ns !== ne) {
                for (var day = startOfDay(r.start) - 86400000; day < viewEnd; day += 86400000) {
                    var a = day + ns * 3600000;
                    var b = (ne > ns ? day : day + 86400000) + ne * 3600000;
                    if (b < r.start || a > viewEnd) continue;
                    var na = Math.max(0, x(a));
                    nights.push({ left: na + "px", width: Math.min(width, x(b)) - na + "px" });
                }
            }

            return {
                blocks: blocks,
                ticks: ticks,
                nights: nights,
                width: width + "px",
                nowLeft: x(now) + "px",
                nowPx: x(now)
            };
        });

        self.zoomLabel = ko.pureComputed(function () {
            return "≈ " + formatDuration((self.tlWidth() / self.pxPerHour()) * 3600) + " visibles";
        });

        var scroller = function () {
            return $("#tab_plugin_octoscheduler .osch-tl-scroll")[0];
        };

        self.updateWidth = function () {
            var el = scroller();
            if (el && el.clientWidth) self.tlWidth(el.clientWidth);
        };

        // zoom en gardant fixe l'instant situé sous anchorPx
        self.zoomAt = function (factor, anchorPx) {
            var el = scroller();
            if (!el) return;
            var old = self.pxPerHour();
            if (anchorPx === undefined) anchorPx = el.clientWidth / 2;
            var anchorHours = (el.scrollLeft + anchorPx) / old;
            var fit = self.fitPxPerHour();
            var next = Math.min(ZOOM_MAX, old * factor);
            if (next <= fit * 1.001) {
                // pas plus loin que la vue complète
                self.zoomFit();
                return;
            }
            self.fitMode(false);
            self.pxPerHourManual(next);
            el.scrollLeft = anchorHours * next - anchorPx;
        };
        self.zoomIn = function () {
            self.zoomAt(1.5);
        };
        self.zoomOut = function () {
            self.zoomAt(1 / 1.5);
        };
        self.zoomFit = function () {
            self.fitMode(true);
            var el = scroller();
            if (el) el.scrollLeft = 0;
        };
        self.scrollToNow = function () {
            var el = scroller();
            if (el) el.scrollLeft = Math.max(0, self.timeline().nowPx - el.clientWidth * 0.1);
        };

        self.setupTimelineNavigation = function () {
            var el = scroller();
            if (!el) return;

            // molette : Ctrl/⌘ (ou pincement trackpad) = zoom, sinon défilement horizontal
            el.addEventListener(
                "wheel",
                function (e) {
                    if (e.ctrlKey || e.metaKey) {
                        e.preventDefault();
                        var rect = el.getBoundingClientRect();
                        var factor = Math.exp(-Math.max(-50, Math.min(50, e.deltaY)) * 0.01);
                        self.zoomAt(factor, e.clientX - rect.left);
                        return;
                    }
                    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
                        var max = el.scrollWidth - el.clientWidth;
                        var atEdge =
                            (e.deltaY < 0 && el.scrollLeft <= 0) || (e.deltaY > 0 && el.scrollLeft >= max - 1);
                        if (max > 0 && !atEdge) {
                            e.preventDefault();
                            el.scrollLeft += e.deltaY;
                        }
                    }
                },
                { passive: false }
            );

            // déplacement en faisant glisser le fond
            var pan = null;
            $(el).on("mousedown", function (e) {
                if (e.button !== 0 || $(e.target).closest("[data-osch-id]").length) return;
                pan = { x: e.clientX, scroll: el.scrollLeft };
                $(el).addClass("osch-panning");
                e.preventDefault();
            });
            $(document).on("mousemove", function (e) {
                if (!pan) return;
                el.scrollLeft = pan.scroll - (e.clientX - pan.x);
            });
            $(document).on("mouseup", function () {
                if (!pan) return;
                pan = null;
                $(el).removeClass("osch-panning");
            });

            $(window).on("resize", _.debounce(self.updateWidth, 150));
            self.updateWidth();
        };

        self.listItems = ko.pureComputed(function () {
            var now = self.nowMin();
            return _.map(self.schedule(), function (s) {
                return _.extend({}, s, {
                    startLabel: s.kind === "current" ? "en cours" : formatClock(s.start, now),
                    endLabel: s.end ? formatClock(s.end, now) : "?",
                    durationLabel: s.unknown ? "inconnue" : formatDuration(s.duration),
                    sourceLabel: s.time_source ? SOURCE_LABELS[s.time_source] : "",
                    progressLabel: s.kind === "current" ? Math.round(s.progress || 0) + " %" : ""
                });
            });
        });

        self.thumbUrl = function (path) {
            return path ? BASEURL + path : null;
        };

        self.formatClock = function (ts) {
            return formatClock(ts, self.nowMin());
        };
        self.formatDuration = formatDuration;

        self.historyStatus = function (h) {
            return { done: "Terminée", failed: "Échouée", cancelled: "Annulée" }[h.status] || h.status;
        };

        self.nextHint = ko.pureComputed(function () {
            var actions = self.readyActions();
            if (!actions.length) return "";
            return "Appuyez sur « Imprimante prête » sur l'imprimante (//action:" + actions[0] + ") pour lancer la suivante.";
        });

        // ----------------------------------------- fichiers disponibles

        self.loadFiles = function () {
            if (!self.loginState.hasPermission(self.access.permissions.FILES_LIST)) return;
            OctoPrint.files.list(true).done(function (response) {
                var out = [];
                var walk = function (entries) {
                    _.each(entries, function (e) {
                        if (e.type === "folder") {
                            walk(e.children || []);
                        } else if (e.type === "machinecode" && e.origin === "local") {
                            out.push({
                                path: e.path,
                                name: e.display || e.name,
                                folder: e.path.indexOf("/") >= 0 ? e.path.substring(0, e.path.lastIndexOf("/")) : "",
                                date: e.date || 0,
                                thumbnail: e.thumbnail ? e.thumbnail.replace(/^\//, "") : null,
                                estimated:
                                    (e.gcodeAnalysis && e.gcodeAnalysis.estimatedPrintTime) || null
                            });
                        }
                    });
                };
                walk(response.files || []);
                out.sort(function (a, b) {
                    return b.date - a.date;
                });
                self.availableFiles(out);
            });
        };

        self.filteredFiles = ko.pureComputed(function () {
            var f = (self.fileFilter() || "").toLowerCase().trim();
            var files = self.availableFiles();
            if (f) {
                files = _.filter(files, function (x) {
                    return x.path.toLowerCase().indexOf(f) >= 0;
                });
            }
            return files.slice(0, 200);
        });

        self.toggleAddPanel = function () {
            self.showAddPanel(!self.showAddPanel());
            if (self.showAddPanel()) self.loadFiles();
        };

        self.addFile = function (file) {
            self.addPaths([file.path]);
        };

        // -------------------------------------- bouton dans la liste de fichiers

        var tpl = $("#files_template_machinecode");
        if (tpl.length) {
            var button =
                '<div class="btn btn-mini btn-files-octoscheduler" ' +
                'data-bind="visible: $root.octoschedulerCanAdd() && $data.origin == \'local\', ' +
                'click: function() { $root.octoschedulerAdd($data); }" ' +
                'title="Ajouter à la file d\'impression" aria-label="Ajouter à la file d\'impression" role="link">' +
                '<i class="fas fa-calendar-plus"></i></div>';
            var html = tpl.text();
            var marker = '<div class="btn btn-mini btn-files-print"';
            if (html.indexOf("btn-files-octoscheduler") < 0 && html.indexOf(marker) >= 0) {
                tpl.text(html.replace(marker, button + marker));
            }
        }
        self.files.octoschedulerAdd = function (data) {
            self.addPaths([data.path]);
        };
        self.files.octoschedulerCanAdd = self.canManage;

        // ------------------------------------------------ glisser-déposer

        var axisFor = function (target) {
            return target === "timeline" ? "x" : "y";
        };

        // index d'insertion (dans la file sans l'élément déplacé)
        var computeIndex = function (container, target, event) {
            var axis = axisFor(target);
            var pos = axis === "x" ? event.clientX : event.clientY;
            var draggedId = self.dragging && self.dragging.type === "item" ? self.dragging.id : null;
            var idx = 0;
            $(container)
                .find("[data-osch-id]")
                .each(function () {
                    if (this.getAttribute("data-osch-id") === draggedId) return;
                    var r = this.getBoundingClientRect();
                    var center = axis === "x" ? r.left + r.width / 2 : r.top + r.height / 2;
                    if (pos > center) idx++;
                });
            return idx;
        };

        var updateIndicator = function (container, target, index) {
            var $c = $(container);
            $c.find(".osch-drop-before, .osch-drop-after").removeClass("osch-drop-before osch-drop-after");
            var draggedId = self.dragging && self.dragging.type === "item" ? self.dragging.id : null;
            var els = $c.find("[data-osch-id]").filter(function () {
                return this.getAttribute("data-osch-id") !== draggedId;
            });
            var marker = $c.find(".osch-drop-marker");
            if (index < els.length) {
                $(els[index]).addClass("osch-drop-before");
                if (target === "timeline") marker.css("left", els[index].style.left).show();
            } else if (els.length) {
                $(els[els.length - 1]).addClass("osch-drop-after");
                if (target === "timeline") {
                    var last = els[els.length - 1];
                    marker.css("left", "calc(" + last.style.left + " + " + last.style.width + ")").show();
                }
            } else if (target === "timeline") {
                var cur = $c.find(".osch-seg-current")[0];
                marker.css("left", cur ? "calc(" + cur.style.left + " + " + cur.style.width + ")" : "0").show();
            }
        };

        var clearIndicators = function () {
            $(".osch-drop-before, .osch-drop-after").removeClass("osch-drop-before osch-drop-after");
            $(".osch-drop-marker").hide();
            $(".osch-dropzone").removeClass("osch-drag-over");
            $(".osch-dragging").removeClass("osch-dragging");
        };

        var setDragData = function (event, payload) {
            var dt = event.originalEvent.dataTransfer;
            if (!dt) return;
            dt.effectAllowed = payload.type === "item" ? "move" : "copy";
            try {
                dt.setData(DND_MIME, JSON.stringify(payload));
            } catch (e) {
                /* IE */
            }
            dt.setData("text/plain", payload.type === "item" ? payload.name || "" : payload.path);
        };

        self.onAfterBinding = function () {
            var root = $("#tab_plugin_octoscheduler");

            // éléments de la file (timeline + liste)
            root.on("dragstart", "[data-osch-id]", function (event) {
                if (!self.canManage()) return false;
                var id = this.getAttribute("data-osch-id");
                self.dragging = { type: "item", id: id };
                self.frozen(true);
                setDragData(event, self.dragging);
                var el = this;
                setTimeout(function () {
                    $(el).addClass("osch-dragging");
                }, 0);
            });

            // fichiers disponibles du panneau d'ajout
            root.on("dragstart", "[data-osch-file]", function (event) {
                if (!self.canManage()) return false;
                self.dragging = { type: "file", path: this.getAttribute("data-osch-file") };
                self.frozen(true);
                setDragData(event, self.dragging);
            });

            root.on("dragover", ".osch-dropzone", function (event) {
                if (!self.dragging) return;
                event.preventDefault();
                var target = this.getAttribute("data-osch-target");
                var dt = event.originalEvent.dataTransfer;
                if (dt) dt.dropEffect = self.dragging.type === "item" ? "move" : "copy";
                if (target === "timeline") {
                    var sc = scroller();
                    var rect = sc.getBoundingClientRect();
                    var cx = event.originalEvent.clientX;
                    if (cx < rect.left + 50) sc.scrollLeft -= 15;
                    else if (cx > rect.right - 50) sc.scrollLeft += 15;
                }
                var idx = computeIndex(this, target, event.originalEvent);
                $(this).addClass("osch-drag-over");
                updateIndicator(this, target, idx);
            });

            root.on("dragleave", ".osch-dropzone", function (event) {
                var rel = event.originalEvent.relatedTarget;
                if (rel && $.contains(this, rel)) return;
                $(this).removeClass("osch-drag-over");
                $(this).find(".osch-drop-before, .osch-drop-after").removeClass("osch-drop-before osch-drop-after");
                $(this).find(".osch-drop-marker").hide();
            });

            root.on("drop", ".osch-dropzone", function (event) {
                if (!self.dragging) return;
                event.preventDefault();
                var target = this.getAttribute("data-osch-target");
                var idx = computeIndex(this, target, event.originalEvent);
                var drag = self.dragging;
                self.dragging = null;
                self.frozen(false);
                clearIndicators();

                if (drag.type === "item") {
                    var ids = _.without(_.pluck(self.queue(), "id"), drag.id);
                    ids.splice(idx, 0, drag.id);
                    if (!_.isEqual(ids, _.pluck(self.queue(), "id"))) self.reorder(ids);
                } else if (drag.type === "file") {
                    self.addPaths([drag.path], idx);
                }
            });

            $(document).on("dragend", function () {
                self.dragging = null;
                self.frozen(false);
                clearIndicators();
            });

            // glisser un fichier depuis la liste de fichiers d'OctoPrint (barre latérale)
            $("#files").on("mouseenter", ".gcode_files .entry.machinecode", function () {
                var data = ko.dataFor(this);
                if (data && data.origin === "local" && self.canManage()) {
                    this.setAttribute("draggable", "true");
                }
            });
            $("#files").on("dragstart", ".gcode_files .entry.machinecode", function (event) {
                var data = ko.dataFor(this);
                if (!data || data.origin !== "local") return;
                self.dragging = { type: "file", path: data.path };
                self.frozen(true);
                setDragData(event, self.dragging);
            });

            self.setupTimelineNavigation();
            self.refresh();
        };

        // ------------------------------------------------------ événements

        self.onDataUpdaterPluginMessage = function (plugin, data) {
            if (plugin !== PLUGIN || !data) return;
            if (data.type === "state") {
                self.applyState(data.state);
            } else if (data.type === "notify") {
                new PNotify({
                    title: "Planificateur",
                    text: _.escape(data.message),
                    type: data.level === "warning" ? "notice" : data.level,
                    hide: data.level !== "error"
                });
            }
        };

        self.onUserLoggedIn = function () {
            self.refresh();
        };

        self.onEventUpdatedFiles = function () {
            if (self.showAddPanel()) self.loadFiles();
        };

        self.onTabChange = function (current) {
            if (current === "#tab_plugin_octoscheduler") {
                self.now(Date.now());
                self.refresh();
            }
        };

        self.onAfterTabChange = function (current) {
            if (current === "#tab_plugin_octoscheduler") {
                self.updateWidth();
                self.zoomFit(); // toujours revenir à la vue complète
            }
        };
    }

    OCTOPRINT_VIEWMODELS.push({
        construct: OctoSchedulerViewModel,
        dependencies: [
            "loginStateViewModel",
            "printerStateViewModel",
            "filesViewModel",
            "accessViewModel",
            "settingsViewModel"
        ],
        elements: ["#tab_plugin_octoscheduler"]
    });
});
