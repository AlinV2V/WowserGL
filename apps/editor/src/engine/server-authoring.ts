import * as THREE from 'three';
import type { EditorApp } from '../editor-app';
import type { SceneComponentModel } from './component-model';

const f = (value: number, digits = 6) => Number.isFinite(value) ? value.toFixed(digits) : '0';

export class ServerAuthoringExporter {
  constructor(private readonly app: EditorApp, private readonly components: SceneComponentModel, root: HTMLElement) {
    const button = document.createElement('button');
    button.textContent = 'Server SQL';
    button.title = 'Export component-authored Creature, GameObject and waypoint data for vMaNGOS';
    button.addEventListener('click', () => this.download());
    root.querySelector('.live-tools')?.append(button);
  }

  createSql() {
    const map = Number(new URLSearchParams(location.search).get('map') ?? 0);
    const creatureRows: string[] = [];
    const gameobjectRows: string[] = [];
    const waypointBlocks: string[] = [];
    const skipped: string[] = [];
    let creatureOffset = 0;
    let gameobjectOffset = 0;

    for (const record of this.app.store.records.values()) {
      if (!record.object.visible || record.state === 'deleted') continue;
      const entity = this.components.entities.get(record.id);
      if (!entity) continue;
      record.object.updateWorldMatrix(true, false);
      const position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3();
      record.object.matrixWorld.decompose(position, quaternion, scale);
      const orientation = new THREE.Euler().setFromQuaternion(quaternion, 'XYZ').z;
      const creature = this.components.getComponent(entity, 'CreatureSpawn');
      const gameobject = this.components.getComponent(entity, 'GameObjectSpawn');
      const path = this.components.getComponent(entity, 'Path');

      if (creature) {
        const entry = Math.floor(Number(creature.data.templateEntry ?? 0));
        if (entry <= 0) skipped.push(`${entity.name}: CreatureSpawn requires creature_template entry`);
        else {
          const index = creatureOffset++;
          const respawn = Math.max(0, Math.floor(Number(creature.data.respawnSeconds ?? 300)));
          const waypoints = Array.isArray(path?.data.waypoints) ? path!.data.waypoints as number[][] : [];
          const authoredMode = String(creature.data.movementMode ?? 'idle');
          const movementType = waypoints.length ? 2 : authoredMode === 'random' ? 1 : 0;
          const wanderDistance = movementType === 1 ? Math.max(0, Number(creature.data.wanderDistance ?? 5)) : 0;
          creatureRows.push(`(@WOWSER_CREATURE_GUID+${index}, ${entry}, ${map}, ${f(position.x)}, ${f(position.y)}, ${f(position.z)}, ${f(orientation, 7)}, ${f(wanderDistance, 3)}, ${movementType}, ${respawn}, ${respawn})`);
          if (authoredMode === 'waypoints' && !waypoints.length) skipped.push(`${entity.name}: waypoint movement is selected but the Path component has no points`);
          if (waypoints.length) {
            const rows = waypoints.filter((point) => point.length >= 3).map((point, pointIndex) => `(@WOWSER_CREATURE_GUID+${index}, ${pointIndex + 1}, ${f(Number(point[0]))}, ${f(Number(point[1]))}, ${f(Number(point[2]))}, 100, 0, 0, 0)`);
            if (rows.length) waypointBlocks.push(`-- ${entity.name}\nINSERT INTO \`creature_movement\` (\`id\`,\`point\`,\`position_x\`,\`position_y\`,\`position_z\`,\`orientation\`,\`waittime\`,\`wander_distance\`,\`script_id\`) VALUES\n${rows.join(',\n')};`);
          }
        }
      }

      if (gameobject) {
        const entry = Math.floor(Number(gameobject.data.templateEntry ?? 0));
        if (entry <= 0) skipped.push(`${entity.name}: GameObjectSpawn requires gameobject_template entry`);
        else {
          const index = gameobjectOffset++;
          const respawn = Math.max(0, Math.floor(Number(gameobject.data.respawnSeconds ?? 300)));
          const state = Math.max(0, Math.floor(Number(gameobject.data.state ?? 1)));
          gameobjectRows.push(`(@WOWSER_GAMEOBJECT_GUID+${index}, ${entry}, ${map}, ${f(position.x)}, ${f(position.y)}, ${f(position.z)}, ${f(orientation, 7)}, ${f(quaternion.x, 7)}, ${f(quaternion.y, 7)}, ${f(quaternion.z, 7)}, ${f(quaternion.w, 7)}, ${respawn}, ${respawn}, 100, ${state}, 1, 0, 0, 10)`);
        }
      }
    }

    const lines = [
      '-- WowserGL Studio server-authoring export',
      `-- Generated ${new Date().toISOString()}`,
      '-- Existing creature_template/gameobject_template entries are required; Studio never invents server template IDs.',
      '-- Creature movement: 0 = idle, 1 = random/wander, 2 = waypoint path.',
      '',
    ];
    if (creatureRows.length) lines.push(
      'SET @WOWSER_CREATURE_GUID := (SELECT COALESCE(MAX(`guid`), 0) FROM `creature`);',
      'INSERT INTO `creature` (`guid`,`id`,`map`,`position_x`,`position_y`,`position_z`,`orientation`,`wander_distance`,`movement_type`,`spawntimesecsmin`,`spawntimesecsmax`) VALUES',
      `${creatureRows.join(',\n')};`,
      '',
      ...waypointBlocks,
      '',
    );
    if (gameobjectRows.length) lines.push(
      'SET @WOWSER_GAMEOBJECT_GUID := (SELECT COALESCE(MAX(`guid`), 0) FROM `gameobject`);',
      'INSERT INTO `gameobject` (`guid`,`id`,`map`,`position_x`,`position_y`,`position_z`,`orientation`,`rotation0`,`rotation1`,`rotation2`,`rotation3`,`spawntimesecsmin`,`spawntimesecsmax`,`animprogress`,`state`,`spawn_flags`,`visibility_mod`,`patch_min`,`patch_max`) VALUES',
      `${gameobjectRows.join(',\n')};`,
      '',
    );
    if (!creatureRows.length && !gameobjectRows.length) lines.push('-- No valid server-spawn components are currently authored.', '');
    if (skipped.length) lines.push('-- Validation notes:', ...[...new Set(skipped)].map((message) => `-- ${message}`), '');
    return lines.join('\n');
  }

  download() {
    const sql = this.createSql();
    const map = Number(new URLSearchParams(location.search).get('map') ?? 0);
    const url = URL.createObjectURL(new Blob([sql], { type: 'text/sql' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `wowsergl_server_authoring_map_${map}.sql`;
    anchor.click();
    URL.revokeObjectURL(url);
    this.app.bottomPanel.log({ level: 'info', message: 'Exported component-authored vMaNGOS Creature/GameObject/waypoint SQL.', time: new Date() });
  }
}
