"""Build Vykor's web identity in an isolated Blender background process.

Usage:
  blender --background --factory-startup --python build-brand.py -- --out <folder>
No existing .blend file or user scene is loaded or changed.
"""
import argparse
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
parser = argparse.ArgumentParser()
parser.add_argument("--out", required=True)
parser.add_argument("--samples", type=int, default=40)
parser.add_argument("--skip-render", action="store_true")
opts = parser.parse_args(args)
out = Path(opts.out).resolve()
out.mkdir(parents=True, exist_ok=True)

# A fresh process owns this factory scene.
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.name = "scrollani"
scene.render.engine = "CYCLES"
scene.cycles.samples = opts.samples
scene.cycles.use_denoising = True
scene.cycles.max_bounces = 10
scene.cycles.transmission_bounces = 8
scene.render.threads_mode = "FIXED"
scene.render.threads = 8
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
scene.render.resolution_percentage = 100
scene.render.fps = 30
scene.frame_start = 0
scene.frame_end = 120
scene.world.use_nodes = True
world_background = next(n for n in scene.world.node_tree.nodes if n.type == "BACKGROUND")
world_background.inputs["Color"].default_value = (0.20, 0.24, 0.22, 1)
world_background.inputs["Strength"].default_value = 0.35
scene.view_settings.view_transform = "AgX"
scene.render.film_transparent = False

model = bpy.data.collections.new("Vykor_Web_Model")
scene.collection.children.link(model)
studio = bpy.data.collections.new("Vykor_Studio")
scene.collection.children.link(studio)

def move_collection(obj, collection):
    for existing in list(obj.users_collection):
        existing.objects.unlink(obj)
    collection.objects.link(obj)

def material(name, color, transmission=0.0, roughness=0.17, ior=1.46):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    node = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    node.inputs["Base Color"].default_value = (*color, 1)
    node.inputs["Metallic"].default_value = 0
    node.inputs["Roughness"].default_value = roughness
    node.inputs["IOR"].default_value = ior
    node.inputs["Transmission Weight"].default_value = transmission
    node.inputs["Coat Weight"].default_value = 0.28
    node.inputs["Coat Roughness"].default_value = 0.11
    mat.diffuse_color = (*color, 1)
    return mat

glass = material("Vykor_Smoked_Optical_Glass", (0.73, 0.82, 0.65), 0.94, 0.075, 1.48)
core = material("Vykor_Lime_Core", (0.57, 0.91, 0.018), 0.05, 0.18, 1.46)
bridge_mat = material("Vykor_Graphite_Connector", (0.09, 0.12, 0.055), 0, 0.24)
ground_mat = material("Vykor_Graphite_Studio", (0.023, 0.031, 0.026), 0, 0.8)

root = bpy.data.objects.new("Vykor_Rig", None)
model.objects.link(root)
root["description"] = "Vykor bracket-and-robot mark, rebuilt from the project's own app icon."
root["scroll_clip"] = "scrollani"
root["scroll_range"] = "0..1 maps to clip time 0..4 seconds"

def polygon(name, coords, depth, mat, bevel=0.035, parent=root):
    curve = bpy.data.curves.new(name + "_Profile", "CURVE")
    curve.dimensions = "2D"
    curve.resolution_u = 1
    curve.fill_mode = "BOTH"
    curve.extrude = depth / 2
    curve.bevel_depth = bevel
    curve.bevel_resolution = 4
    spline = curve.splines.new("POLY")
    spline.points.add(len(coords) - 1)
    for p, (x, z) in zip(spline.points, coords):
        p.co = (x, z, 0, 1)
    spline.use_cyclic_u = True
    obj = bpy.data.objects.new(name, curve)
    model.objects.link(obj)
    obj.rotation_euler.x = math.pi / 2
    obj.parent = parent
    obj.data.materials.append(mat)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.convert(target="MESH")
    obj = bpy.context.object
    for p in obj.data.polygons:
        p.use_smooth = len(p.vertices) == 4
    obj.select_set(False)
    return obj

left_profile = [
    (-0.54, 1.43), (-1.20, 1.43), (-1.62, 1.04),
    (-1.62, -1.04), (-1.20, -1.43), (-0.54, -1.43),
    (-0.54, -1.00), (-1.04, -1.00), (-1.18, -0.85),
    (-1.18, 0.85), (-1.04, 1.00), (-0.54, 1.00)
]
left = polygon("Bracket_Left", left_profile, 0.26, glass, 0.055)
right = polygon("Bracket_Right", [(-x, z) for x, z in reversed(left_profile)], 0.26, glass, 0.055)

# Small coloured edge inserts provide a recognisable green accent without emissive glow.
edge_l = polygon("Lime_Inlay_Left", left_profile, 0.035, core, 0.018, left)
edge_l.location.y = -0.12
edge_l.scale = (0.987, 0.987, 1)
edge_l.rotation_euler = (0, 0, 0)
edge_r = polygon("Lime_Inlay_Right", [(-x, z) for x, z in reversed(left_profile)], 0.035, core, 0.018, right)
edge_r.location.y = -0.12
edge_r.scale = (0.987, 0.987, 1)
edge_r.rotation_euler = (0, 0, 0)

# Use the glass shells as the dominant material; inlays sit behind the shell.
edge_l.location = (0, 0, -0.18)
edge_r.location = (0, 0, -0.18)

def rounded_rect(width, height, radius, segments=10, cx=0, cz=0):
    pts = []
    for x, z, angle in [
        (width / 2 - radius, height / 2 - radius, 0),
        (width / 2 - radius, -height / 2 + radius, 90),
        (-width / 2 + radius, -height / 2 + radius, 180),
        (-width / 2 + radius, height / 2 - radius, 270)
    ]:
        for i in range(segments + 1):
            a = math.radians(angle + 90 * i / segments)
            pts.append((cx + x + radius * math.sin(a), cz + z + radius * math.cos(a)))
    return pts

# Rebuild the face as a rounded plate with two real holes.
face = polygon("Robot_Face", rounded_rect(1.02, 0.95, 0.20), 0.27, core, 0.035)
for x in [-0.185, 0.185]:
    cutter = polygon("Temporary_Eye_Cutter", rounded_rect(0.135, 0.37, 0.065, cx=x), 1.1, bridge_mat, 0.005)
    modifier = face.modifiers.new("Eye_opening", "BOOLEAN")
    modifier.operation = "DIFFERENCE"
    modifier.solver = "EXACT"
    modifier.object = cutter
    bpy.context.view_layer.objects.active = face
    face.select_set(True)
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    face.select_set(False)
    bpy.data.objects.remove(cutter, do_unlink=True)

bridge_l = polygon("Connector_Left", rounded_rect(0.72, 0.10, 0.035, cx=-0.82), 0.12, bridge_mat, 0.01)
bridge_r = polygon("Connector_Right", rounded_rect(0.72, 0.10, 0.035, cx=0.82), 0.12, bridge_mat, 0.01)

# Animation contains transforms only: portable to Three.js, R3F and any glTF player.
# The materials remain editable; their scroll-linked optical interpolation happens at runtime.
for frame, scale, pitch, yaw in [
    (0, 2.45, 6, -11),
    (40, 1.78, 4, -6),
    (85, 1.12, 1, -2),
    (120, 1.0, 0, 0)
]:
    root.scale = (scale,) * 3
    root.rotation_euler = (math.radians(pitch), 0, math.radians(yaw))
    root.keyframe_insert("scale", frame=frame)
    root.keyframe_insert("rotation_euler", frame=frame)

for part, sign in [(left, -1), (right, 1)]:
    for frame, offset, angle in [(0, 0.28, 8), (45, 0.13, 4), (95, 0.0, 0), (120, 0, 0)]:
        part.location.x = sign * offset
        part.rotation_euler.y = math.radians(sign * angle)
        part.keyframe_insert("location", frame=frame)
        part.keyframe_insert("rotation_euler", frame=frame)

for obj in [root, left, right]:
    if obj.animation_data and obj.animation_data.action:
        obj.animation_data.action.name = "scrollani_" + obj.name
        obj["animation_group"] = "scrollani"

def area(name, location, power, size, color, target=(0, 0, 0), size_y=None):
    data = bpy.data.lights.new(name, "AREA")
    data.energy = power
    data.color = color
    data.shape = "RECTANGLE"
    data.size = size
    data.size_y = size_y if size_y is not None else size * 0.7
    obj = bpy.data.objects.new(name, data)
    studio.objects.link(obj)
    obj.location = location
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()
    return obj

area("Softbox_Key", (-3.8, -4.7, 4.4), 1100, 4.0, (0.92, 1.0, 0.91))
area("Softbox_Rim", (4.0, 1.5, 2.4), 1450, 3.4, (0.87, 1.0, 0.74))
area("Softbox_Fill", (1.5, -3.4, -3.5), 500, 3.2, (0.84, 0.91, 1.0))
area("Softbox_Strip", (-4, -1.4, -0.6), 700, 0.45, (1, 1, 1), size_y=5)

cam_data = bpy.data.cameras.new("Camera1")
cam = bpy.data.objects.new("Camera1", cam_data)
studio.objects.link(cam)
cam.location = (0, -9.0, 0.12)
cam.rotation_euler = (Vector((0, 0, 0)) - cam.location).to_track_quat("-Z", "Y").to_euler()
cam_data.type = "PERSP"
cam_data.lens = 58
scene.camera = cam

# An opaque plane gives the render physically meaningful transmission and shadows.
bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0.65, 0), rotation=(math.pi/2, 0, 0))
backdrop = bpy.context.object
backdrop.name = "Studio_Backdrop"
move_collection(backdrop, studio)
backdrop.data.materials.append(ground_mat)

scene.frame_set(120)
bpy.ops.object.select_all(action="DESELECT")
for obj in model.objects:
    obj.select_set(True)
bpy.context.view_layer.objects.active = root
bpy.ops.export_scene.gltf(
    filepath=str(out / "vykor-optical-mark.glb"),
    export_format="GLB",
    use_selection=True,
    export_animations=True,
    export_animation_mode="SCENE",
    export_nla_strips_merged_animation_name="scrollani",
    export_anim_scene_split_object=False,
    export_frame_range=True,
    export_force_sampling=True,
    export_yup=True,
    export_cameras=False,
    export_lights=False,
    export_extras=True,
)
scene.frame_set(120)
bpy.ops.wm.save_as_mainfile(filepath=str(out / "vykor-optical-mark.blend"))

manifest = {
    "brand": "Vykor",
    "source": "apps/desktop/resources/icon.png (project-owned reference)",
    "asset": "vykor-optical-mark.glb",
    "clip": "scrollani",
    "duration_seconds": 4,
    "scroll_mapping": "clamp(progress, 0, 1) * 4",
    "front": "+Z in exported glTF, +Y up",
    "parts": [o.name for o in model.objects],
    "materials": ["Vykor_Smoked_Optical_Glass", "Vykor_Lime_Core", "Vykor_Graphite_Connector"],
    "runtime_material_hint": {
        "ior": [1.35, 1.48],
        "transmission": [0.94, 0.94],
        "roughness": [0.075, 0.10],
        "thickness": [0.16, 0.28],
        "note": "Use a lit environment in Three.js; the glTF model does not contain its studio environment."
    },
    "posters": [],
}
if not opts.skip_render:
    # Full mark for reduced motion, small-size handoff and non-WebGL fallback.
    scene.frame_set(120)
    scene.render.resolution_x = 1400
    scene.render.resolution_y = 1400
    backdrop.hide_render = True
    scene.render.film_transparent = True
    scene.render.filepath = str(out / "vykor-mark-transparent.png")
    bpy.ops.render.render(write_still=True)
    manifest["posters"].append("vykor-mark-transparent.png")

    # Ready-to-use wide stills, matching the first and last states of the scroll scene.
    backdrop.hide_render = False
    scene.render.film_transparent = False
    scene.render.resolution_x = 1920
    scene.render.resolution_y = 1080
    cam_data.lens = 48
    for frame, name in [(0, "hero-closeup.png"), (120, "hero-assembled.png")]:
        scene.frame_set(frame)
        scene.render.filepath = str(out / name)
        bpy.ops.render.render(write_still=True)
        manifest["posters"].append(name)
    scene.frame_set(120)
    bpy.ops.wm.save_as_mainfile(filepath=str(out / "vykor-optical-mark.blend"))
(out / "brand-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
print("VYKOR_BRAND_COMPLETE " + json.dumps({"folder":str(out),"parts":len(model.objects),"posters":manifest["posters"]}))

