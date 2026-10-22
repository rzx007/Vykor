"""Prepare web formats and verify that the exported model has a usable 4-second clip."""
from pathlib import Path
import base64, json, struct
from PIL import Image

root = Path(__file__).resolve().parent.parent
brand = root / "brand"
path = brand / "vykor-optical-mark.glb"
data = path.read_bytes()
magic, version, _ = struct.unpack_from("<III", data, 0)
assert magic == 0x46546C67 and version == 2
json_size, kind = struct.unpack_from("<II", data, 12)
assert kind == 0x4E4F534A
doc = json.loads(data[20:20+json_size])
assert len(doc.get("animations", [])) == 1
doc["animations"][0]["name"] = "scrollani"
encoded = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode()
encoded += b" " * (-len(encoded) % 4)
tail = data[20+json_size:]
rebuilt = struct.pack("<III", magic, version, 20+len(encoded)+len(tail)) + struct.pack("<II", len(encoded), kind) + encoded + tail
path.write_bytes(rebuilt)
bin_data = tail[8:]
times = []
for sampler in doc["animations"][0]["samplers"]:
    accessor = doc["accessors"][sampler["input"]]
    view = doc["bufferViews"][accessor["bufferView"]]
    offset = view.get("byteOffset",0) + accessor.get("byteOffset",0)
    assert accessor["componentType"] == 5126 and accessor["type"] == "SCALAR"
    values = struct.unpack_from("<" + "f" * accessor["count"], bin_data, offset)
    assert all(b >= a for a,b in zip(values,values[1:]))
    times.extend(values)
assert abs(max(times)-4) < 0.01 and abs(min(times)) < 0.01
for name in ["hero-closeup","hero-assembled","vykor-mark-transparent"]:
    im = Image.open(brand / (name+".png"))
    im.save(brand / (name+".webp"), "WEBP", quality=90, method=6)
manifest = json.loads((brand/"brand-manifest.json").read_text("utf-8"))
manifest["clip"] = "scrollani"
manifest["duration_seconds"] = max(times)
manifest["layers"] = {"Lime_Inlay_Left":"optional coloured insert; hide for clear glass", "Lime_Inlay_Right":"optional coloured insert; hide for clear glass"}
manifest["validated"] = {"glb_version":2,"external_images":len(doc.get("images",[])),"channels":len(doc["animations"][0]["channels"]),"animation_time_range":[min(times),max(times)],"no_external_geometry_buffers":all("uri" not in b for b in doc["buffers"])}
manifest["web_posters"] = ["hero-closeup.webp","hero-assembled.webp","vykor-mark-transparent.webp"]
(brand/"brand-manifest.json").write_text(json.dumps(manifest,ensure_ascii=False,indent=2),"utf-8")
print(json.dumps({"model_bytes":len(rebuilt),"clip":"scrollani","duration":max(times),"posters":manifest["web_posters"]},ensure_ascii=False))

