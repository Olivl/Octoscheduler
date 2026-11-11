# -*- coding: utf-8 -*-
"""
OctoScheduler - file d'attente d'impressions pour OctoPrint.

- Les fichiers ajoutés sont imprimés les uns après les autres.
- L'impression suivante démarre quand l'imprimante signale qu'elle est prête
  (commande hôte ``//action:ready`` envoyée par exemple par le menu
  « Imprimante prête » / « Set Ready » des firmwares Prusa), ou via le bouton
  de l'interface.
"""

import hashlib
import io
import json
import os
import threading
import time
import uuid

import flask
import octoprint.plugin
from octoprint.access import ADMIN_GROUP, USER_GROUP
from octoprint.access.permissions import Permissions
from octoprint.events import Events
from octoprint.filemanager.destinations import FileDestinations

from .gcode_info import extract_info

QUEUE_FILE = "queue.json"
THUMB_DIR = "thumbs"
HISTORY_SIZE = 30


class OctoSchedulerPlugin(
    octoprint.plugin.StartupPlugin,
    octoprint.plugin.SettingsPlugin,
    octoprint.plugin.AssetPlugin,
    octoprint.plugin.TemplatePlugin,
    octoprint.plugin.BlueprintPlugin,
    octoprint.plugin.EventHandlerPlugin,
):
    def __init__(self):
        super().__init__()
        self._lock = threading.RLock()
        self._queue = []  # éléments en attente (l'impression en cours n'en fait pas partie)
        self._active = None  # élément de la file actuellement en impression
        self._starting = None  # élément dont on a demandé le démarrage
        self._history = []
        self._info_cache = {}  # path -> infos extraites du G-code
        self._last_ready = 0

    # ------------------------------------------------------------------ startup

    def on_after_startup(self):
        self._thumb_dir = os.path.join(self.get_plugin_data_folder(), THUMB_DIR)
        os.makedirs(self._thumb_dir, exist_ok=True)
        self._load()
        with self._lock:
            if self._active:
                # OctoPrint a redémarré pendant une impression : elle est perdue,
                # on la remet en tête de file pour ne pas l'oublier.
                item = dict(self._active)
                item.pop("started", None)
                self._queue.insert(0, item)
                self._active = None
                self._logger.info("Impression interrompue remise en file : %s", item["path"])
        self._save()
        self._logger.info(
            "OctoScheduler prêt, %d fichier(s) en file, actions 'prête' : %s",
            len(self._queue),
            ", ".join(self._ready_actions()),
        )

    # ----------------------------------------------------------------- settings

    def get_settings_defaults(self):
        return {
            # noms des commandes hôte "//action:<nom>" qui lancent l'impression suivante
            "ready_actions": "ready",
            # temps estimé entre deux impressions (retrait du plateau, etc.)
            "changeover_minutes": 5,
            # remettre en tête de file une impression échouée / annulée
            "requeue_on_failure": True,
            # source préférée pour la durée : auto | slicer | octoprint
            "time_source": "auto",
            # mise en évidence de la nuit sur la timeline
            "night_start": 22,
            "night_end": 7,
        }

    def get_settings_version(self):
        return 1

    def on_settings_save(self, data):
        octoprint.plugin.SettingsPlugin.on_settings_save(self, data)
        self._info_cache.clear()
        self._broadcast()

    def _ready_actions(self):
        raw = self._settings.get(["ready_actions"]) or ""
        return [a.strip().lower() for a in raw.replace(";", ",").split(",") if a.strip()]

    # ------------------------------------------------------------------- assets

    def get_assets(self):
        return {
            "js": ["js/octoscheduler.js"],
            "css": ["css/octoscheduler.css"],
        }

    def get_template_configs(self):
        return [
            {"type": "tab", "name": "Planificateur", "custom_bindings": True},
            {"type": "settings", "name": "OctoScheduler", "custom_bindings": False},
        ]

    def is_template_autoescaped(self):
        return True

    # -------------------------------------------------------------- persistance

    def _queue_path(self):
        return os.path.join(self.get_plugin_data_folder(), QUEUE_FILE)

    def _load(self):
        path = self._queue_path()
        if not os.path.exists(path):
            return
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            with self._lock:
                self._queue = data.get("queue", [])
                self._active = data.get("active")
                self._history = data.get("history", [])
        except Exception:
            self._logger.exception("Impossible de lire %s", path)

    def _save(self):
        with self._lock:
            data = {
                "queue": self._queue,
                "active": self._active,
                "history": self._history[-HISTORY_SIZE:],
            }
        path = self._queue_path()
        tmp = path + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=1)
            os.replace(tmp, path)
        except Exception:
            self._logger.exception("Impossible d'écrire %s", path)

    def _changed(self):
        self._save()
        self._broadcast()

    # ------------------------------------------------------------ infos fichier

    def _file_info(self, path):
        """Durée estimée + miniature d'un fichier local (avec cache)."""
        result = {
            "exists": False,
            "estimated_time": None,
            "time_source": None,
            "thumbnail": None,  # URL relative à la racine d'OctoPrint
            "size": None,
        }
        if not path or not self._file_manager.file_exists(FileDestinations.LOCAL, path):
            return result

        disk_path = self._file_manager.path_on_disk(FileDestinations.LOCAL, path)
        try:
            stat = os.stat(disk_path)
        except OSError:
            return result
        result["exists"] = True
        result["size"] = stat.st_size

        key = "{}:{}:{}".format(path, stat.st_mtime, stat.st_size)
        cached = self._info_cache.get(path)
        if not cached or cached.get("key") != key:
            cached = {"key": key, "slicer_time": None, "thumb": None}
            try:
                info = extract_info(disk_path)
                cached["slicer_time"] = info["estimated_time"]
                if info["thumbnail"]:
                    mime, raw = info["thumbnail"]
                    ext = "jpg" if mime == "image/jpeg" else "png"
                    name = hashlib.sha1(key.encode("utf-8")).hexdigest() + "." + ext
                    thumb_path = os.path.join(self._thumb_dir, name)
                    if not os.path.exists(thumb_path):
                        with open(thumb_path, "wb") as f:
                            f.write(raw)
                    cached["thumb"] = name
            except Exception:
                self._logger.exception("Analyse de %s impossible", path)
            self._info_cache[path] = cached

        # Durées possibles
        candidates = {}
        try:
            metadata = self._file_manager.get_metadata(FileDestinations.LOCAL, path) or {}
        except Exception:
            metadata = {}
        stats = metadata.get("statistics", {}) or {}
        profile = self._printer_profile_manager.get_current_or_default().get("id")
        avg = (stats.get("averagePrintTime") or {}).get(profile)
        if avg:
            candidates["history"] = avg
        if cached.get("slicer_time"):
            candidates["slicer"] = cached["slicer_time"]
        analysis_time = (metadata.get("analysis") or {}).get("estimatedPrintTime")
        if analysis_time:
            candidates["octoprint"] = analysis_time

        source = self._settings.get(["time_source"])
        if source == "octoprint":
            order = ["octoprint", "history", "slicer"]
        elif source == "slicer":
            order = ["slicer", "history", "octoprint"]
        elif self._has_plugin("PrintTimeGenius"):
            # PrintTimeGenius remplace l'estimation d'OctoPrint par une bien meilleure
            order = ["history", "octoprint", "slicer"]
        else:
            order = ["history", "slicer", "octoprint"]
        for src in order:
            if candidates.get(src):
                result["estimated_time"] = float(candidates[src])
                result["time_source"] = src
                break

        # Miniature : celle du plugin "Slicer Thumbnails" si présente, sinon la nôtre.
        # URL relative à la racine d'OctoPrint.
        external = metadata.get("thumbnail")
        if external and isinstance(external, str):
            result["thumbnail"] = external.lstrip("/")
        elif cached.get("thumb"):
            result["thumbnail"] = "plugin/{}/thumbnail/{}".format(
                self._identifier, cached["thumb"]
            )
        return result

    def _has_plugin(self, identifier):
        info = self._plugin_manager.get_plugin_info(identifier)
        return bool(info and info.enabled)

    def _serialize_item(self, item):
        data = dict(item)
        data.update(self._file_info(item["path"]))
        return data

    def _current_job(self):
        """Impression en cours (lancée ou non par le planificateur)."""
        if not (self._printer.is_printing() or self._printer.is_paused()):
            return None
        job = self._printer.get_current_job() or {}
        file = job.get("file") or {}
        path = file.get("path")
        if not path:
            return None
        data = {
            "path": path,
            "name": file.get("display") or file.get("name") or os.path.basename(path),
            "origin": file.get("origin"),
            "from_queue": bool(self._active and self._active["path"] == path),
        }
        if file.get("origin") == FileDestinations.LOCAL:
            data.update(self._file_info(path))
        return data

    def _state(self):
        with self._lock:
            queue = [self._serialize_item(i) for i in self._queue]
            history = list(self._history[-HISTORY_SIZE:])
        return {
            "queue": queue,
            "current": self._current_job(),
            "history": history[::-1],
            "ready_actions": self._ready_actions(),
            "changeover_minutes": self._settings.get_float(["changeover_minutes"]) or 0,
            "night_start": self._settings.get_int(["night_start"]),
            "night_end": self._settings.get_int(["night_end"]),
            "can_start": self._can_start()[0],
        }

    def _broadcast(self):
        try:
            self._plugin_manager.send_plugin_message(
                self._identifier, {"type": "state", "state": self._state()}
            )
        except Exception:
            self._logger.exception("Diffusion de l'état impossible")

    def _notify(self, level, message):
        self._plugin_manager.send_plugin_message(
            self._identifier, {"type": "notify", "level": level, "message": message}
        )

    # --------------------------------------------------------- gestion de file

    def _add(self, path):
        path = str(path or "").replace("\\", "/").strip("/")
        if not path or ".." in path.split("/"):
            raise ValueError("Chemin invalide : {}".format(path))
        if not self._file_manager.file_exists(FileDestinations.LOCAL, path):
            raise ValueError("Fichier introuvable : {}".format(path))
        item = {
            "id": uuid.uuid4().hex[:12],
            "path": path,
            "name": os.path.basename(path),
            "added": time.time(),
        }
        with self._lock:
            self._queue.append(item)
        return item

    def _can_start(self):
        if self._printer.is_printing() or self._printer.is_paused():
            return False, "Une impression est déjà en cours."
        if not self._printer.is_operational():
            return False, "L'imprimante n'est pas connectée."
        if not self._printer.is_ready():
            return False, "L'imprimante n'est pas prête."
        with self._lock:
            if not self._queue:
                return False, "La file d'attente est vide."
        return True, None

    def start_next(self, user=None, trigger="ui"):
        ok, reason = self._can_start()
        if not ok:
            return False, reason

        with self._lock:
            # on saute les fichiers qui n'existent plus
            while self._queue and not self._file_manager.file_exists(
                FileDestinations.LOCAL, self._queue[0]["path"]
            ):
                missing = self._queue.pop(0)
                self._notify("error", "Fichier introuvable, retiré : " + missing["name"])
            if not self._queue:
                self._changed()
                return False, "La file d'attente est vide."
            item = self._queue[0]
            self._starting = item

        self._logger.info("Démarrage de %s (déclencheur : %s)", item["path"], trigger)
        try:
            self._printer.select_file(
                item["path"],
                False,
                printAfterSelect=True,
                user=user,
                tags={"source:plugin", "plugin:octoscheduler", "trigger:" + trigger},
            )
        except Exception as e:
            self._logger.exception("Démarrage impossible")
            with self._lock:
                self._starting = None
            return False, str(e)
        return True, None

    # ------------------------------------------------- commande "prête" (hook)

    def on_action_command(self, comm, line, action, name="", params="", *args, **kwargs):
        if (name or "").lower() not in self._ready_actions():
            return
        # anti-rebond : le firmware peut répéter le message
        now = time.monotonic()
        if now - self._last_ready < 5:
            return
        self._last_ready = now
        self._logger.info("Imprimante prête (//action:%s)", name)
        # ne jamais bloquer le thread de communication série
        threading.Thread(target=self._on_printer_ready, daemon=True).start()

    def _on_printer_ready(self):
        time.sleep(0.5)
        with self._lock:
            empty = not self._queue
        if empty:
            self._notify("info", "Imprimante prête, mais la file d'attente est vide.")
            return
        ok, reason = self.start_next(trigger="printer_ready")
        if not ok:
            self._notify("warning", "Impression suivante non lancée : " + reason)

    # ------------------------------------------------------------- événements

    def on_event(self, event, payload):
        payload = payload or {}

        if event == Events.PRINT_STARTED:
            with self._lock:
                starting = self._starting
                self._starting = None
                if (
                    starting
                    and payload.get("origin") == FileDestinations.LOCAL
                    and payload.get("path") == starting["path"]
                ):
                    self._queue = [i for i in self._queue if i["id"] != starting["id"]]
                    starting["started"] = time.time()
                    self._active = starting
                else:
                    self._active = None
            self._changed()

        elif event in (Events.PRINT_DONE, Events.PRINT_FAILED, Events.PRINT_CANCELLED):
            with self._lock:
                active = self._active
                self._active = None
                if active and payload.get("path") == active["path"]:
                    status = {
                        Events.PRINT_DONE: "done",
                        Events.PRINT_FAILED: "failed",
                        Events.PRINT_CANCELLED: "cancelled",
                    }[event]
                    self._history.append(
                        {
                            "name": active["name"],
                            "path": active["path"],
                            "status": status,
                            "started": active.get("started"),
                            "ended": time.time(),
                            "duration": payload.get("time"),
                        }
                    )
                    self._history = self._history[-HISTORY_SIZE:]
                    if status != "done" and self._settings.get_boolean(
                        ["requeue_on_failure"]
                    ):
                        requeue_item = dict(active)
                        requeue_item.pop("started", None)
                        self._queue.insert(0, requeue_item)
            self._changed()

        elif event == Events.FILE_MOVED:
            if payload.get("source_storage") == FileDestinations.LOCAL:
                self._rename_paths(payload.get("source_path"), payload.get("destination_path"))

        elif event == Events.FOLDER_MOVED:
            if payload.get("source_storage") == FileDestinations.LOCAL:
                self._rename_paths(
                    payload.get("source_path"), payload.get("destination_path"), folder=True
                )

        elif event in (
            Events.FILE_REMOVED,
            Events.FOLDER_REMOVED,
            Events.UPDATED_FILES,
            Events.METADATA_ANALYSIS_FINISHED,
            Events.METADATA_STATISTICS_UPDATED,
            Events.PRINTER_STATE_CHANGED,
        ):
            self._broadcast()

    def _rename_paths(self, src, dst, folder=False):
        if not src or not dst:
            return
        changed = False
        with self._lock:
            for item in self._queue:
                p = item["path"]
                if p == src:
                    item["path"] = dst
                elif folder and p.startswith(src.rstrip("/") + "/"):
                    item["path"] = dst.rstrip("/") + p[len(src.rstrip("/")) :]
                else:
                    continue
                item["name"] = os.path.basename(item["path"])
                changed = True
        if changed:
            self._changed()

    # -------------------------------------------------------------------- API

    def is_blueprint_protected(self):
        return True

    def is_blueprint_csrf_protected(self):
        return True

    def get_blueprint_api_prefixes(self):
        return ["/state", "/queue", "/start"]

    @staticmethod
    def _require(permission):
        if not permission.can():
            flask.abort(403)

    @octoprint.plugin.BlueprintPlugin.route("/state", methods=["GET"])
    def api_state(self):
        self._require(Permissions.FILES_LIST)
        return flask.jsonify(self._state())

    @octoprint.plugin.BlueprintPlugin.route("/queue/add", methods=["POST"])
    def api_add(self):
        self._require(Permissions.PLUGIN_OCTOSCHEDULER_MANAGE)
        data = flask.request.get_json(silent=True) or {}
        paths = data.get("paths") or ([data["path"]] if data.get("path") else [])
        if not paths:
            flask.abort(400, description="paramètre 'path' ou 'paths' manquant")
        index = data.get("index")
        added = []
        try:
            for p in paths:
                added.append(self._add(p))
        except ValueError as e:
            flask.abort(404, description=str(e))
        if index is not None:
            with self._lock:
                ids = {i["id"] for i in added}
                rest = [i for i in self._queue if i["id"] not in ids]
                index = max(0, min(int(index), len(rest)))
                self._queue = rest[:index] + added + rest[index:]
        self._changed()
        return flask.jsonify(self._state())

    @octoprint.plugin.BlueprintPlugin.route("/queue/remove", methods=["POST"])
    def api_remove(self):
        self._require(Permissions.PLUGIN_OCTOSCHEDULER_MANAGE)
        data = flask.request.get_json(silent=True) or {}
        item_id = data.get("id")
        with self._lock:
            self._queue = [i for i in self._queue if i["id"] != item_id]
        self._changed()
        return flask.jsonify(self._state())

    @octoprint.plugin.BlueprintPlugin.route("/queue/reorder", methods=["POST"])
    def api_reorder(self):
        self._require(Permissions.PLUGIN_OCTOSCHEDULER_MANAGE)
        data = flask.request.get_json(silent=True) or {}
        order = data.get("order") or []
        with self._lock:
            by_id = {i["id"]: i for i in self._queue}
            new_queue = [by_id.pop(i) for i in order if i in by_id]
            new_queue.extend(i for i in self._queue if i["id"] in by_id)  # oubliés
            self._queue = new_queue
        self._changed()
        return flask.jsonify(self._state())

    @octoprint.plugin.BlueprintPlugin.route("/queue/clear", methods=["POST"])
    def api_clear(self):
        self._require(Permissions.PLUGIN_OCTOSCHEDULER_MANAGE)
        with self._lock:
            self._queue = []
        self._changed()
        return flask.jsonify(self._state())

    @octoprint.plugin.BlueprintPlugin.route("/start", methods=["POST"])
    def api_start(self):
        self._require(Permissions.PRINT)
        user = None
        try:
            from flask_login import current_user

            user = current_user.get_name()
        except Exception:
            pass
        ok, reason = self.start_next(user=user, trigger="ui")
        if not ok:
            flask.abort(409, description=reason)
        return flask.jsonify(self._state())

    @octoprint.plugin.BlueprintPlugin.route("/thumbnail/<name>", methods=["GET"])
    def api_thumbnail(self, name):
        self._require(Permissions.FILES_LIST)
        name = os.path.basename(name)
        path = os.path.join(self._thumb_dir, name)
        if not os.path.isfile(path):
            flask.abort(404)
        mime = "image/jpeg" if name.endswith(".jpg") else "image/png"
        with open(path, "rb") as f:
            data = f.read()
        response = flask.send_file(io.BytesIO(data), mimetype=mime)
        response.headers["Cache-Control"] = "private, max-age=86400"
        return response

    # ------------------------------------------------------------ permissions

    def get_additional_permissions(self, *args, **kwargs):
        return [
            {
                "key": "MANAGE",
                "name": "Gérer la file d'impression",
                "description": "Ajouter, retirer et réordonner les fichiers du planificateur",
                "roles": ["manage"],
                "default_groups": [ADMIN_GROUP, USER_GROUP],
            }
        ]

    # ---------------------------------------------------------- mise à jour

    def get_update_information(self):
        return {
            "octoscheduler": {
                "displayName": "OctoScheduler",
                "displayVersion": self._plugin_version,
                "type": "github_release",
                "user": "Olivl",
                "repo": "Octoscheduler",
                "current": self._plugin_version,
                "pip": "https://github.com/Olivl/Octoscheduler/archive/{target_version}.zip",
            }
        }


__plugin_name__ = "OctoScheduler"
__plugin_pythoncompat__ = ">=3.7,<4"


def __plugin_load__():
    global __plugin_implementation__
    __plugin_implementation__ = OctoSchedulerPlugin()

    global __plugin_hooks__
    __plugin_hooks__ = {
        "octoprint.comm.protocol.action": __plugin_implementation__.on_action_command,
        "octoprint.access.permissions": __plugin_implementation__.get_additional_permissions,
        "octoprint.plugin.softwareupdate.check_config": __plugin_implementation__.get_update_information,
    }
