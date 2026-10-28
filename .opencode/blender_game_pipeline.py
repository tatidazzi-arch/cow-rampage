from __future__ import annotations

from typing import Any

import bpy


def _require_mesh(obj_name: str) -> bpy.types.Object:
    obj = bpy.data.objects.get(obj_name)
    if obj is None:
        raise ValueError(f"Objeto nao encontrado: {obj_name}")
    if obj.type != "MESH":
        raise TypeError(f"Objeto nao e uma malha: {obj_name}")
    return obj


def audit_scene_polycount() -> dict[str, Any]:
    """Retorna vertices, faces, triangulos e estado das transformacoes por malha."""
    bpy.context.view_layer.update()
    objects: list[dict[str, Any]] = []
    total_vertices = 0
    total_triangles = 0

    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        mesh = obj.data
        mesh.calc_loop_triangles()
        vertices = len(mesh.vertices)
        faces = len(mesh.polygons)
        triangles = len(mesh.loop_triangles)
        scale_applied = all(abs(value - 1.0) < 1e-6 for value in obj.scale)
        rotation_applied = all(abs(value) < 1e-6 for value in obj.rotation_euler)
        pivot_at_origin = obj.matrix_world.translation.length < 1e-6
        objects.append(
            {
                "name": obj.name,
                "vertices": vertices,
                "faces": faces,
                "triangles": triangles,
                "scale_applied": scale_applied,
                "rotation_applied": rotation_applied,
                "transforms_applied": scale_applied and rotation_applied,
                "pivot_at_origin": pivot_at_origin,
            }
        )
        total_vertices += vertices
        total_triangles += triangles

    return {
        "objects": objects,
        "total_vertices": total_vertices,
        "total_triangles": total_triangles,
    }


def apply_game_transforms(obj_name: str) -> None:
    """Aplica location, rotacao e escala, zera o pivô e recalcula as normais."""
    obj = _require_mesh(obj_name)
    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    obj.data.update()


def generate_lod_decimate(obj_name: str, ratio: float) -> str:
    """Duplica a malha e aplica um Decimate COLLAPSE com o ratio informado."""
    if not 0.0 < ratio <= 1.0:
        raise ValueError("ratio deve estar entre 0.0 (exclusivo) e 1.0")
    source = _require_mesh(obj_name)
    duplicate = source.copy()
    duplicate.data = source.data.copy()
    duplicate.name = f"{source.name}_LOD_{round(ratio * 100)}"
    duplicate.data.name = f"{duplicate.name}_Mesh"
    collection = source.users_collection[0] if source.users_collection else bpy.context.scene.collection
    collection.objects.link(duplicate)

    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="DESELECT")
    duplicate.select_set(True)
    bpy.context.view_layer.objects.active = duplicate
    modifier = duplicate.modifiers.new(name="GameLOD", type="DECIMATE")
    modifier.decimate_type = "COLLAPSE"
    modifier.ratio = max(0.01, min(1.0, ratio))
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    return duplicate.name


def export_game_glb(filepath: str, selected_only: bool = False) -> None:
    """Exporta um GLB otimizado para Three.js e Rapier3D."""
    bpy.ops.export_scene.gltf(
        filepath=filepath,
        export_format="GLB",
        export_apply=True,
        export_yup=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        use_selection=selected_only,
    )
