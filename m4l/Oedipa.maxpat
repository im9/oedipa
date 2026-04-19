{
    "patcher": {
        "fileversion": 1,
        "appversion": {
            "major": 9,
            "minor": 0,
            "revision": 0,
            "architecture": "x64",
            "modernui": 1
        },
        "classnamespace": "box",
        "rect": [80.0, 80.0, 1200.0, 820.0],
        "bglocked": 0,
        "openinpresentation": 0,
        "default_fontsize": 12.0,
        "default_fontface": 0,
        "default_fontname": "Arial",
        "gridonopen": 1,
        "gridsize": [15.0, 15.0],
        "gridsnaponopen": 1,
        "objectsnaponopen": 1,
        "statusbarvisible": 2,
        "toolbarvisible": 1,
        "boxes": [
            {"box": {"id": "obj-header", "maxclass": "comment", "text": "Oedipa — Tonnetz chord walker", "numinlets": 1, "numoutlets": 0, "fontsize": 14.0, "patching_rect": [40.0, 10.0, 240.0, 22.0]}},

            {"box": {"id": "obj-midiin", "maxclass": "newobj", "text": "midiin", "numinlets": 1, "numoutlets": 1, "outlettype": ["int"], "patching_rect": [40.0, 60.0, 45.0, 22.0]}},
            {"box": {"id": "obj-midiout", "maxclass": "newobj", "text": "midiout", "numinlets": 1, "numoutlets": 0, "patching_rect": [40.0, 720.0, 52.0, 22.0]}},

            {"box": {"id": "obj-thisdevice", "maxclass": "newobj", "text": "live.thisdevice", "numinlets": 1, "numoutlets": 3, "outlettype": ["bang", "bang", ""], "patching_rect": [130.0, 60.0, 102.0, 22.0]}},
            {"box": {"id": "obj-print-thisdev", "maxclass": "newobj", "text": "print thisdev", "numinlets": 1, "numoutlets": 0, "patching_rect": [240.0, 60.0, 85.0, 22.0]}},
            {"box": {"id": "obj-loadbang", "maxclass": "newobj", "text": "loadbang", "numinlets": 1, "numoutlets": 1, "outlettype": ["bang"], "patching_rect": [130.0, 90.0, 65.0, 22.0]}},
            {"box": {"id": "obj-debug-bang", "maxclass": "button", "numinlets": 1, "numoutlets": 1, "outlettype": ["bang"], "patching_rect": [210.0, 90.0, 24.0, 24.0]}},
            {"box": {"id": "obj-debug-comment", "maxclass": "comment", "text": "manual re-resolve (debug)", "numinlets": 1, "numoutlets": 0, "patching_rect": [240.0, 92.0, 170.0, 20.0]}},

            {"box": {"id": "obj-getid-msg", "maxclass": "message", "text": "getid", "numinlets": 2, "numoutlets": 1, "outlettype": [""], "patching_rect": [130.0, 130.0, 46.0, 22.0]}},
            {"box": {"id": "obj-livepath", "maxclass": "newobj", "text": "live.path live_set", "numinlets": 1, "numoutlets": 3, "outlettype": ["", "", ""], "patching_rect": [130.0, 170.0, 115.0, 22.0]}},
            {"box": {"id": "obj-print-lp", "maxclass": "newobj", "text": "print lp", "numinlets": 1, "numoutlets": 0, "patching_rect": [260.0, 170.0, 60.0, 22.0]}},

            {"box": {"id": "obj-liveobserver", "maxclass": "newobj", "text": "live.observer is_playing", "numinlets": 2, "numoutlets": 3, "outlettype": ["", "", ""], "patching_rect": [130.0, 210.0, 160.0, 22.0]}},
            {"box": {"id": "obj-print-lo", "maxclass": "newobj", "text": "print lo", "numinlets": 1, "numoutlets": 0, "patching_rect": [310.0, 210.0, 60.0, 22.0]}},

            {"box": {"id": "obj-sel-stop", "maxclass": "newobj", "text": "sel 0", "numinlets": 1, "numoutlets": 2, "outlettype": ["bang", ""], "patching_rect": [130.0, 250.0, 42.0, 22.0]}},

            {"box": {"id": "obj-test-bang", "maxclass": "button", "numinlets": 1, "numoutlets": 1, "outlettype": ["bang"], "patching_rect": [480.0, 60.0, 24.0, 24.0]}},
            {"box": {"id": "obj-test-comment", "maxclass": "comment", "text": "manual step (test)", "numinlets": 1, "numoutlets": 0, "patching_rect": [510.0, 62.0, 130.0, 20.0]}},
            {"box": {"id": "obj-metro", "maxclass": "newobj", "text": "metro 16n @quantize 16n @active 0", "numinlets": 2, "numoutlets": 1, "outlettype": ["bang"], "patching_rect": [480.0, 250.0, 220.0, 22.0]}},
            {"box": {"id": "obj-print-metro", "maxclass": "newobj", "text": "print metro", "numinlets": 1, "numoutlets": 0, "patching_rect": [710.0, 250.0, 80.0, 22.0]}},
            {"box": {"id": "obj-metro-comment", "maxclass": "comment", "text": "Live transport sync", "numinlets": 1, "numoutlets": 0, "patching_rect": [800.0, 252.0, 140.0, 20.0]}},
            {"box": {"id": "obj-counter", "maxclass": "newobj", "text": "counter", "numinlets": 5, "numoutlets": 4, "outlettype": ["int", "int", "int", "int"], "patching_rect": [480.0, 290.0, 55.0, 22.0]}},
            {"box": {"id": "obj-prepend-step", "maxclass": "newobj", "text": "prepend step", "numinlets": 1, "numoutlets": 1, "outlettype": [""], "patching_rect": [480.0, 330.0, 85.0, 22.0]}},

            {"box": {"id": "obj-panic-bang", "maxclass": "button", "numinlets": 1, "numoutlets": 1, "outlettype": ["bang"], "patching_rect": [770.0, 60.0, 24.0, 24.0]}},
            {"box": {"id": "obj-panic-comment", "maxclass": "comment", "text": "panic (all notes off)", "numinlets": 1, "numoutlets": 0, "patching_rect": [800.0, 62.0, 140.0, 20.0]}},
            {"box": {"id": "obj-panic-msg", "maxclass": "message", "text": "panic", "numinlets": 2, "numoutlets": 1, "outlettype": [""], "patching_rect": [770.0, 110.0, 46.0, 22.0]}},

            {"box": {"id": "obj-nodescript", "maxclass": "newobj", "text": "node.script /Users/tn/src/vst/oedipa/m4l/host/index.js @autostart 1", "numinlets": 1, "numoutlets": 2, "outlettype": ["", ""], "patching_rect": [130.0, 390.0, 420.0, 22.0]}},

            {"box": {"id": "obj-print", "maxclass": "newobj", "text": "print from_node", "numinlets": 1, "numoutlets": 0, "patching_rect": [130.0, 440.0, 105.0, 22.0]}},

            {"box": {"id": "obj-route", "maxclass": "newobj", "text": "route note", "numinlets": 1, "numoutlets": 2, "outlettype": ["", ""], "patching_rect": [480.0, 440.0, 75.0, 22.0]}},
            {"box": {"id": "obj-unpack", "maxclass": "newobj", "text": "unpack 0 0 0", "numinlets": 1, "numoutlets": 3, "outlettype": ["int", "int", "int"], "patching_rect": [480.0, 500.0, 80.0, 22.0]}},
            {"box": {"id": "obj-pack", "maxclass": "newobj", "text": "pack 0 0", "numinlets": 2, "numoutlets": 1, "outlettype": [""], "patching_rect": [480.0, 560.0, 60.0, 22.0]}},
            {"box": {"id": "obj-midiformat", "maxclass": "newobj", "text": "midiformat", "numinlets": 2, "numoutlets": 1, "outlettype": ["int"], "patching_rect": [480.0, 620.0, 70.0, 22.0]}}
        ],
        "lines": [
            {"patchline": {"source": ["obj-midiin", 0], "destination": ["obj-midiout", 0]}},

            {"patchline": {"source": ["obj-thisdevice", 0], "destination": ["obj-print-thisdev", 0]}},
            {"patchline": {"source": ["obj-thisdevice", 0], "destination": ["obj-getid-msg", 0]}},
            {"patchline": {"source": ["obj-loadbang", 0], "destination": ["obj-getid-msg", 0]}},
            {"patchline": {"source": ["obj-debug-bang", 0], "destination": ["obj-getid-msg", 0]}},
            {"patchline": {"source": ["obj-getid-msg", 0], "destination": ["obj-livepath", 0]}},
            {"patchline": {"source": ["obj-livepath", 0], "destination": ["obj-liveobserver", 0]}},
            {"patchline": {"source": ["obj-livepath", 0], "destination": ["obj-print-lp", 0]}},
            {"patchline": {"source": ["obj-liveobserver", 0], "destination": ["obj-print-lo", 0]}},
            {"patchline": {"source": ["obj-liveobserver", 0], "destination": ["obj-metro", 0]}},
            {"patchline": {"source": ["obj-liveobserver", 0], "destination": ["obj-sel-stop", 0]}},
            {"patchline": {"source": ["obj-sel-stop", 0], "destination": ["obj-panic-msg", 0]}},

            {"patchline": {"source": ["obj-metro", 0], "destination": ["obj-counter", 0]}},
            {"patchline": {"source": ["obj-metro", 0], "destination": ["obj-print-metro", 0]}},
            {"patchline": {"source": ["obj-test-bang", 0], "destination": ["obj-counter", 0]}},
            {"patchline": {"source": ["obj-counter", 0], "destination": ["obj-prepend-step", 0]}},
            {"patchline": {"source": ["obj-prepend-step", 0], "destination": ["obj-nodescript", 0]}},

            {"patchline": {"source": ["obj-panic-bang", 0], "destination": ["obj-panic-msg", 0]}},
            {"patchline": {"source": ["obj-panic-msg", 0], "destination": ["obj-nodescript", 0]}},

            {"patchline": {"source": ["obj-nodescript", 0], "destination": ["obj-print", 0]}},
            {"patchline": {"source": ["obj-nodescript", 0], "destination": ["obj-route", 0]}},

            {"patchline": {"source": ["obj-route", 0], "destination": ["obj-unpack", 0]}},
            {"patchline": {"source": ["obj-unpack", 0], "destination": ["obj-pack", 0]}},
            {"patchline": {"source": ["obj-unpack", 1], "destination": ["obj-pack", 1]}},
            {"patchline": {"source": ["obj-pack", 0], "destination": ["obj-midiformat", 0]}},
            {"patchline": {"source": ["obj-midiformat", 0], "destination": ["obj-midiout", 0]}}
        ]
    }
}
