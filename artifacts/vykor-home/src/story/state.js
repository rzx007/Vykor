export const STORY_STEPS = Object.freeze([
  Object.freeze({
    id: 'prompt',
    title: '先说说，要做什么。',
    description: '写下要做的事，把上下文一起带进来。',
  }),
  Object.freeze({
    id: 'conversation',
    title: '把事情，讨论清楚。',
    description: '讨论目标、梳理步骤，让下一步更清楚。',
  }),
  Object.freeze({
    id: 'projects',
    title: '让工作，有个归处。',
    description: '会话按项目整理，回来时找到原来的思路。',
  }),
  Object.freeze({
    id: 'files',
    title: '打开文件，接着做。',
    description: '文件、终端与浏览器，就在对话旁边。',
  }),
  Object.freeze({
    id: 'workspace',
    title: '这就是，你的 Vykor。',
    description: '同一个项目，同一个工作台。试着切换右侧工具。',
  }),
]);

const POSE_KEYS = ['x', 'y', 'z', 'scale', 'rotationX', 'rotationY', 'opacity'];
const REST = Object.freeze({ x: 0, y: 0, z: 0, scale: 1, rotationX: 0, rotationY: 0, opacity: 1 });

function clampProgress(raw) {
  if (typeof raw !== 'number' || Number.isNaN(raw)) return 0;
  return Math.max(0, Math.min(1, raw));
}

function smoothWindow(progress, start, end) {
  const value = Math.max(0, Math.min(1, (progress - start) / (end - start)));
  return value * value * (3 - 2 * value);
}

function mix(start, end, amount) {
  return start + (end - start) * amount;
}

function pose(overrides) {
  return { ...REST, ...overrides };
}

function mixPose(start, end, amount) {
  return Object.fromEntries(POSE_KEYS.map((key) => [key, mix(start[key], end[key], amount)]));
}

function enteringPart(start, end, amount, assembly) {
  return mixPose(mixPose(pose({ opacity: 0, ...start }), pose(end), amount), REST, assembly);
}

/**
 * Sample one reversible story pose. x/z use the whole machine width; y uses
 * its height. Rotations are degrees, partRadius is CSS pixels, and all opacity
 * values are 0..1. The caller scales the coordinates, never each part's bounds.
 */
export function sampleStoryProgress(raw) {
  const progress = clampProgress(raw);
  const assembly = smoothWindow(progress, 0.8, 0.92);
  const prompt = smoothWindow(progress, 0.06, 0.20);
  const handoff = smoothWindow(progress, 0.06, 0.27);
  const copyEntrance = smoothWindow(progress, 0.12, 0.20);
  const closing = smoothWindow(progress, 0.93, 0.985);
  const conversation = smoothWindow(progress, 0.3, 0.42);
  const sidebar = smoothWindow(progress, 0.46, 0.58);
  const tools = smoothWindow(progress, 0.62, 0.74);
  const enclosure = smoothWindow(progress, 0.76, 0.86);

  const composerFocus = mixPose(
    pose({ x: 0.08, y: -0.3, z: 0, scale: 0.88, opacity: 0 }),
    pose({ x: 0.08, y: -0.3, z: 0.08, scale: 1.32 }),
    prompt,
  );
  // Resolve the surface early; a long translucent overlap makes the UI unreadable.
  composerFocus.opacity = smoothWindow(progress, 0.06, 0.13);
  const composerContext = mixPose(composerFocus, pose({ x: 0.02, y: 0.02, z: 0.06 }), conversation);

  const parts = {
    shell: enteringPart(
      { y: 0.035, z: -0.1, scale: 1.035 },
      { z: -0.045, scale: 1.0125 },
      enclosure,
      assembly,
    ),
    chrome: enteringPart(
      { x: -0.035, y: -0.035, z: 0.14, scale: 0.98, rotationX: 5, rotationY: -4 },
      { y: -0.01, z: 0.05 },
      enclosure,
      assembly,
    ),
    sidebar: enteringPart(
      { x: -0.18, y: 0.06, z: 0.24, scale: 0.96, rotationX: 3, rotationY: -4 },
      { x: -0.04, y: 0.02, z: 0.08 },
      sidebar,
      assembly,
    ),
    conversation: enteringPart(
      { x: 0.15, y: -0.1, z: 0.2, scale: 0.96, rotationX: 3, rotationY: -5 },
      { x: 0.02, y: -0.03, z: 0.06 },
      conversation,
      assembly,
    ),
    composer: mixPose(composerContext, REST, assembly),
    tools: enteringPart(
      { x: 0.14, y: -0.06, z: 0.24, scale: 0.96, rotationX: 3, rotationY: 4 },
      { x: 0.04, y: -0.02, z: 0.08 },
      tools,
      assembly,
    ),
  };

  const workspaceCopy = smoothWindow(progress, 0.8, 0.9);
  const copyOpacities = [
    1 - conversation,
    conversation - sidebar,
    sidebar - tools,
    tools - workspaceCopy,
    workspaceCopy,
  ];
  let phaseIndex = 0;
  for (let index = 1; index < copyOpacities.length; index += 1) {
    if (copyOpacities[index] > copyOpacities[phaseIndex]) phaseIndex = index;
  }

  return {
    progress,
    introOpacity: 1 - smoothWindow(progress, 0.06, 0.12),
    modelOpacity: 1 - smoothWindow(progress, 0.12, 0.25),
    introLift: smoothWindow(progress, 0.06, 0.22),
    sceneOpacity: smoothWindow(progress, 0.06, 0.14),
    copyEntrance,
    composerHandoff: handoff,
    utilityOpacity: smoothWindow(progress, 0.20, 0.29),
    closingOpacity: closing,
    brandProgress: 0.055 * smoothWindow(progress, 0, 0.1),
    camera: {
      x: mix(-0.015 * handoff, 0, assembly),
      y: mix(0.015 * handoff, 0, assembly),
      scale: mix(mix(1, 0.88, handoff), 1, smoothWindow(progress, 0.27, 0.92)),
      rotationX: mix(10 * handoff, 0, assembly),
      rotationY: mix(-12 * handoff, 0, assembly),
    },
    parts,
    copyOpacities,
    phaseIndex,
    assembled: progress >= 0.92,
    partRadius: mix(14, 0, assembly),
  };
}
