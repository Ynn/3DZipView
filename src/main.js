import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const MODEL_EXTENSIONS = new Set(['fbx', 'glb', 'gltf', 'obj']);
const TEXTURE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'webp',
  'bmp',
  'gif',
  'tga',
  'dds'
]);
const MATERIAL_EXTENSIONS = new Set(['mtl']);
const BUFFER_EXTENSIONS = new Set(['bin']);
const UPLOAD_EXTENSIONS = new Set(['zip', ...MODEL_EXTENSIONS]);
const RELEVANT_ARCHIVE_EXTENSIONS = new Set([
  ...MODEL_EXTENSIONS,
  ...TEXTURE_EXTENSIONS,
  ...MATERIAL_EXTENSIONS,
  ...BUFFER_EXTENSIONS
]);
const TARGET_VIEW_SIZE = 240;
const THUMBNAIL_SIZE = 256;
const CACHE_LIMIT_BYTES = 200 * 1024 * 1024;
const CACHE_LIMIT_ARCHIVES = 2;
const CAMERA_DIRECTION = new THREE.Vector3(1, 0.72, 1).normalize();

const dom = {
  dropOverlay: document.getElementById('drop-overlay'),
  fileInput: document.getElementById('file-input'),
  browseBtn: document.getElementById('browse-btn'),
  mountFolderBtn: document.getElementById('mount-folder-btn'),
  clearBtn: document.getElementById('clear-btn'),
  statusBanner: document.getElementById('status-banner'),
  archiveList: document.getElementById('archive-list'),
  libraryCount: document.getElementById('library-count'),
  archiveMeta: document.getElementById('archive-meta'),
  archiveMetaTitle: document.getElementById('archive-meta-title'),
  archiveMetaBadge: document.getElementById('archive-meta-badge'),
  archiveSummary: document.getElementById('archive-summary'),
  metaFiles: document.getElementById('meta-files'),
  metaTextures: document.getElementById('meta-textures'),
  metaMaterials: document.getElementById('meta-materials'),
  metaSize: document.getElementById('meta-size'),
  modelCount: document.getElementById('model-count'),
  modelList: document.getElementById('model-list'),
  inspectorToggle: document.getElementById('inspector-toggle'),
  inspectorCloseBtn: document.getElementById('inspector-close-btn'),
  viewerContainer: document.getElementById('viewer-container'),
  emptyView: document.getElementById('empty-view'),
  emptyTitle: document.getElementById('empty-title'),
  emptyDescription: document.getElementById('empty-description'),
  hud: document.getElementById('hud'),
  hudFormat: document.getElementById('hud-format'),
  hudTitle: document.getElementById('hud-title'),
  hudSubtitle: document.getElementById('hud-subtitle'),
  viewLitBtn: document.getElementById('view-lit-btn'),
  viewUnlitBtn: document.getElementById('view-unlit-btn'),
  viewWireframeBtn: document.getElementById('view-wireframe-btn'),
  resetCamBtn: document.getElementById('reset-cam-btn'),
  toggleGridBtn: document.getElementById('toggle-grid-btn'),
  toggleAnimBtn: document.getElementById('toggle-anim-btn'),
  exportBtn: document.getElementById('export-btn'),
  loadingScreen: document.getElementById('loading'),
  loadingText: document.getElementById('loading-text')
};

const state = {
  archives: [],
  selectedArchiveId: null,
  currentArchiveId: null,
  currentModelPath: null,
  currentSourceObject: null,
  currentPresentationRoot: null,
  currentMixer: null,
  currentAnimations: [],
  currentDispose: null,
  currentStats: null,
  renderMode: 'lit',
  animationsPlaying: true,
  gridVisible: true,
  dragDepth: 0,
  loadRequestId: 0,
  indexQueue: [],
  isIndexing: false,
  thumbnailQueue: [],
  isGeneratingThumbnail: false,
  statusTimer: null,
  inspectorOpen: false,
  supportsDirectoryAccess: false
};

const moduleCache = {};

let scene;
let camera;
let renderer;
let controls;
let clock;
let gridHelper;

let thumbScene;
let thumbCamera;
let thumbRenderer;

initApp();

function initApp() {
  initOptionalFeatures();
  bindEvents();
  renderArchiveList();
  renderArchiveDetails();
  showInitialEmptyState();
  syncInspectorState();
  updateToolbarState();
  initViewer();
}

function initOptionalFeatures() {
  state.supportsDirectoryAccess = Boolean(
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    'showDirectoryPicker' in window
  );

  dom.mountFolderBtn.classList.toggle('hidden', !state.supportsDirectoryAccess);
}

function bindEvents() {
  dom.browseBtn.addEventListener('click', () => dom.fileInput.click());
  dom.mountFolderBtn.addEventListener('click', mountDirectory);
  dom.clearBtn.addEventListener('click', clearLibrary);

  dom.fileInput.addEventListener('change', (event) => {
    const files = Array.from(event.target.files || []);
    processFiles(files);
    dom.fileInput.value = '';
  });

  dom.inspectorToggle.addEventListener('click', () => {
    if (dom.inspectorToggle.disabled) {
      return;
    }
    setInspectorOpen(!state.inspectorOpen);
  });

  dom.inspectorCloseBtn.addEventListener('click', () => setInspectorOpen(false));

  dom.resetCamBtn.addEventListener('click', () => {
    if (state.currentPresentationRoot) {
      fitCameraToObject(state.currentPresentationRoot);
    }
  });

  dom.toggleGridBtn.addEventListener('click', () => {
    state.gridVisible = !state.gridVisible;
    if (gridHelper) {
      gridHelper.visible = state.gridVisible;
    }
    updateToolbarState();
  });

  dom.toggleAnimBtn.addEventListener('click', () => {
    if (!state.currentMixer) {
      return;
    }

    state.animationsPlaying = !state.animationsPlaying;
    state.currentMixer.timeScale = state.animationsPlaying ? 1 : 0;
    updateToolbarState();
  });

  dom.exportBtn.addEventListener('click', exportCurrentModelAsGlb);
  dom.viewLitBtn.addEventListener('click', () => setRenderMode('lit'));
  dom.viewUnlitBtn.addEventListener('click', () => setRenderMode('unlit'));
  dom.viewWireframeBtn.addEventListener('click', () => setRenderMode('wireframe'));

  document.addEventListener('dragenter', handleDragEnter);
  document.addEventListener('dragover', handleDragOver);
  document.addEventListener('dragleave', handleDragLeave);
  document.addEventListener('drop', handleDrop);
  window.addEventListener('resize', onWindowResize);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      resetDragOverlay();
      if (state.inspectorOpen) {
        setInspectorOpen(false);
      }
    }
  });
}

function initViewer() {
  try {
    scene = new THREE.Scene();
    scene.background = null;

    camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
    camera.position.set(220, 140, 220);

    renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance'
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(dom.viewerContainer.clientWidth, dom.viewerContainer.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.02;
    renderer.setClearAlpha(0);
    renderer.domElement.setAttribute('aria-hidden', 'true');
    dom.viewerContainer.prepend(renderer.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.screenSpacePanning = false;

    const ambientLight = new THREE.HemisphereLight(0xf2eee7, 0x17191c, 1.1);
    scene.add(ambientLight);

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.8);
    keyLight.position.set(240, 360, 180);
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xd8c8b3, 0.72);
    fillLight.position.set(-240, 180, -140);
    scene.add(fillLight);

    gridHelper = new THREE.GridHelper(1000, 40, 0x8d7356, 0x393532);
    gridHelper.material.opacity = 0.2;
    gridHelper.material.transparent = true;
    gridHelper.visible = state.gridVisible;
    scene.add(gridHelper);

    clock = new THREE.Clock();
    initThumbnailRenderer();
    onWindowResize();
    animate();
  } catch (error) {
    console.error('Viewer initialisation failed:', error);
    showStatus(
      'WebGL is unavailable in this browser. The 3D viewport could not be initialised.',
      'error',
      { sticky: true }
    );
    showEmptyView(
      'WebGL unavailable',
      '3D rendering could not be initialised. Try a modern browser with hardware acceleration enabled.'
    );
  }
}

function initThumbnailRenderer() {
  thumbScene = new THREE.Scene();
  thumbScene.background = new THREE.Color(0x1a1c1f);

  thumbCamera = new THREE.PerspectiveCamera(40, 1, 0.1, 1000);
  thumbRenderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance'
  });
  thumbRenderer.setSize(THUMBNAIL_SIZE, THUMBNAIL_SIZE);
  thumbRenderer.outputColorSpace = THREE.SRGBColorSpace;
  thumbRenderer.toneMapping = THREE.ACESFilmicToneMapping;
  thumbRenderer.toneMappingExposure = 1.02;

  const ambientLight = new THREE.HemisphereLight(0xf4f0ea, 0x17191c, 1.08);
  thumbScene.add(ambientLight);

  const keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
  keyLight.position.set(160, 180, 120);
  thumbScene.add(keyLight);

  const rimLight = new THREE.DirectionalLight(0xcaab86, 0.48);
  rimLight.position.set(-140, 90, -120);
  thumbScene.add(rimLight);
}

function animate() {
  requestAnimationFrame(animate);

  if (!renderer || !scene || !camera) {
    return;
  }

  const delta = clock ? clock.getDelta() : 0;

  if (state.currentMixer && state.animationsPlaying) {
    state.currentMixer.update(delta);
  }

  if (controls) {
    controls.update();
  }

  renderer.render(scene, camera);
}

function onWindowResize() {
  if (!renderer || !camera) {
    return;
  }

  const width = dom.viewerContainer.clientWidth;
  const height = dom.viewerContainer.clientHeight;

  if (width <= 0 || height <= 0) {
    return;
  }

  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
}

function handleDragEnter(event) {
  if (!containsFiles(event.dataTransfer)) {
    return;
  }

  event.preventDefault();
  state.dragDepth += 1;
  dom.dropOverlay.classList.remove('hidden');
  dom.dropOverlay.setAttribute('aria-hidden', 'false');
}

function handleDragOver(event) {
  if (!containsFiles(event.dataTransfer)) {
    return;
  }

  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'copy';
  }
}

function handleDragLeave(event) {
  if (!containsFiles(event.dataTransfer)) {
    return;
  }

  event.preventDefault();
  state.dragDepth = Math.max(0, state.dragDepth - 1);
  if (state.dragDepth === 0) {
    resetDragOverlay();
  }
}

function handleDrop(event) {
  if (!containsFiles(event.dataTransfer)) {
    return;
  }

  event.preventDefault();
  const files = Array.from(event.dataTransfer.files || []);
  resetDragOverlay();
  processFiles(files);
}

function resetDragOverlay() {
  state.dragDepth = 0;
  dom.dropOverlay.classList.add('hidden');
  dom.dropOverlay.setAttribute('aria-hidden', 'true');
}

function containsFiles(dataTransfer) {
  return Boolean(dataTransfer && Array.from(dataTransfer.types || []).includes('Files'));
}

function processFiles(files) {
  if (files.length === 0) {
    return;
  }

  const validFiles = [];
  let skippedDuplicates = 0;
  let skippedUnsupported = 0;

  for (const file of files) {
    const extension = getFileExtension(file.name);
    if (!UPLOAD_EXTENSIONS.has(extension)) {
      skippedUnsupported += 1;
      continue;
    }

    if (isDuplicateFile(file)) {
      skippedDuplicates += 1;
      continue;
    }

    validFiles.push(file);
  }

  if (validFiles.length === 0) {
    if (skippedUnsupported > 0 || skippedDuplicates > 0) {
      showStatus(buildImportSkipMessage(skippedUnsupported, skippedDuplicates), 'warning');
    }
    return;
  }

  const newArchives = validFiles.map(createArchiveRecord);
  state.archives.push(...newArchives);
  state.indexQueue.push(...newArchives);
  renderArchiveList();
  renderArchiveDetails();
  processIndexQueue();

  if (skippedUnsupported > 0 || skippedDuplicates > 0) {
    showStatus(buildImportSkipMessage(skippedUnsupported, skippedDuplicates), 'warning');
  } else {
    showStatus(
      `${pluralize(validFiles.length, 'asset added', 'assets added')} to the library.`,
      'info'
    );
  }
}

async function mountDirectory() {
  if (!state.supportsDirectoryAccess) {
    return;
  }

  try {
    const handle = await window.showDirectoryPicker({ mode: 'read' });
    const snapshot = await scanDirectoryHandle(handle, { requireDirectModel: false });
    const nextArchives = [];
    let skippedDuplicates = 0;

    if (snapshot.modelEntries.length > 0) {
      nextArchives.push(createDirectoryArchiveRecord(handle, snapshot));
    }

    for (const zipEntry of snapshot.zipEntries) {
      const file = await zipEntry.handle.getFile();
      const archiveName = `${handle.name}/${zipEntry.label}`;

      if (isDuplicateFile(file, archiveName)) {
        skippedDuplicates += 1;
        continue;
      }

      nextArchives.push(createArchiveRecord(file, { name: archiveName }));
    }

    if (nextArchives.length === 0) {
      const message = skippedDuplicates > 0
        ? 'This folder only contains ZIP packages that are already in the library.'
        : 'No ZIP packages or loadable 3D models were found in this folder.';
      showStatus(message, 'warning');
      return;
    }

    state.archives.push(...nextArchives);
    state.indexQueue.push(...nextArchives);
    renderArchiveList();
    renderArchiveDetails();
    processIndexQueue();

    const directorySourceCount = nextArchives.filter((archive) => archive.sourceType === 'directory').length;
    const zipSourceCount = nextArchives.filter((archive) => archive.sourceType === 'zip').length;
    const parts = [];

    if (directorySourceCount > 0) {
      parts.push(pluralize(directorySourceCount, 'folder source'));
    }

    if (zipSourceCount > 0) {
      parts.push(pluralize(zipSourceCount, 'ZIP package'));
    }

    if (skippedDuplicates > 0) {
      parts.push(pluralize(skippedDuplicates, 'duplicate skipped', 'duplicates skipped'));
    }

    showStatus(`Mounted ${handle.name}: ${parts.join(' | ')}.`, 'info');
  } catch (error) {
    if (error?.name === 'AbortError') {
      return;
    }

    console.error('Directory mount failed:', error);
    showStatus(`Unable to open folder: ${cleanupErrorMessage(error.message)}`, 'error', {
      sticky: true
    });
  }
}

function createArchiveRecord(file, options = {}) {
  const archiveName = options.name || file.name;
  const extension = getFileExtension(archiveName);

  return {
    id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
    sourceFile: file,
    name: archiveName,
    size: file.size,
    sourceType: extension === 'zip' ? 'zip' : 'file',
    uploadExtension: extension,
    status: 'queued',
    errorMessage: '',
    totalFiles: extension === 'zip' ? 0 : 1,
    textureCount: 0,
    materialCount: 0,
    modelEntries: [],
    selectedModelPath: null,
    thumbnail: null,
    thumbnailStatus: 'idle',
    thumbnailKey: null,
    assetBundle: null,
    assetBundlePromise: null,
    assetBundleBytes: 0,
    cacheAccessAt: 0,
    directorySnapshot: null,
    removed: false
  };
}

function createDirectoryArchiveRecord(handle, snapshot = null) {
  return {
    id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
    sourceFile: null,
    sourceHandle: handle,
    name: handle.name,
    size: snapshot?.totalBytes ?? 0,
    sourceType: 'directory',
    uploadExtension: 'directory',
    status: 'queued',
    errorMessage: '',
    totalFiles: snapshot?.totalFiles ?? 0,
    textureCount: snapshot?.textureCount ?? 0,
    materialCount: snapshot?.materialCount ?? 0,
    modelEntries: snapshot?.modelEntries ?? [],
    selectedModelPath: null,
    thumbnail: null,
    thumbnailStatus: 'idle',
    thumbnailKey: null,
    assetBundle: null,
    assetBundlePromise: null,
    assetBundleBytes: 0,
    cacheAccessAt: 0,
    directorySnapshot: snapshot,
    removed: false
  };
}

async function processIndexQueue() {
  if (state.isIndexing) {
    return;
  }

  state.isIndexing = true;

  while (state.indexQueue.length > 0) {
    const archive = state.indexQueue.shift();
    if (!archive || archive.removed || !isArchiveTracked(archive.id)) {
      continue;
    }

    archive.status = 'indexing';
    archive.errorMessage = '';
    renderArchiveList();
    renderArchiveDetails();

    try {
      const metadata = await inspectArchive(archive);
      if (!isArchiveTracked(archive.id)) {
        continue;
      }

      archive.status = 'ready';
      archive.totalFiles = metadata.totalFiles;
      archive.textureCount = metadata.textureCount;
      archive.materialCount = metadata.materialCount;
      archive.modelEntries = metadata.modelEntries;
      archive.selectedModelPath = metadata.modelEntries[0]?.path || null;
      archive.errorMessage = '';

      queueThumbnailGeneration(archive);

      if (!state.selectedArchiveId) {
        selectArchive(archive.id);
      } else if (state.selectedArchiveId === archive.id) {
        renderArchiveDetails();
        loadSelectedArchive();
      } else {
        renderArchiveDetails();
      }
    } catch (error) {
      if (!isArchiveTracked(archive.id)) {
        continue;
      }

      archive.status = 'error';
      archive.errorMessage = cleanupErrorMessage(error.message);
      archive.modelEntries = [];
      archive.selectedModelPath = null;

      if (state.selectedArchiveId === archive.id) {
        cancelCurrentLoad();
        showEmptyView('Invalid source', archive.errorMessage);
      }

      showStatus(`Unable to analyze ${archive.name}: ${archive.errorMessage}`, 'error', {
        sticky: true
      });
    }

    renderArchiveList();
    renderArchiveDetails();
  }

  state.isIndexing = false;
  selectFirstReadyArchiveIfNeeded();
}

async function inspectArchive(archive) {
  if (archive.sourceType === 'directory') {
    const snapshot = archive.directorySnapshot ?? await scanDirectoryHandle(archive.sourceHandle);
    archive.directorySnapshot = snapshot;
    archive.size = snapshot.totalBytes;

    return {
      totalFiles: snapshot.totalFiles,
      textureCount: snapshot.textureCount,
      materialCount: snapshot.materialCount,
      modelEntries: snapshot.modelEntries
    };
  }

  if (archive.sourceType !== 'zip') {
    const label = archive.name;
    return {
      totalFiles: 1,
      textureCount: 0,
      materialCount: 0,
      modelEntries: [
        {
          path: normalizeArchivePath(label),
          label,
          extension: archive.uploadExtension
        }
      ]
    };
  }

  const JSZip = await getJSZip();
  const zipContent = await JSZip.loadAsync(archive.sourceFile);
  const modelEntries = [];
  let totalFiles = 0;
  let textureCount = 0;
  let materialCount = 0;

  zipContent.forEach((relativePath, zipEntry) => {
    if (zipEntry.dir) {
      return;
    }

    totalFiles += 1;
    const normalizedPath = normalizeArchivePath(relativePath);
    const extension = getFileExtension(normalizedPath);

    if (MODEL_EXTENSIONS.has(extension)) {
      modelEntries.push({
        path: normalizedPath,
        label: relativePath.replace(/\\/g, '/'),
        extension
      });
    }

    if (TEXTURE_EXTENSIONS.has(extension)) {
      textureCount += 1;
    }

    if (MATERIAL_EXTENSIONS.has(extension)) {
      materialCount += 1;
    }
  });

  if (modelEntries.length === 0) {
    throw new Error('No supported FBX, GLB, GLTF or OBJ model was found in this ZIP package.');
  }

  modelEntries.sort((left, right) => {
    const lengthDelta = left.label.length - right.label.length;
    return lengthDelta !== 0 ? lengthDelta : left.label.localeCompare(right.label);
  });

  return {
    totalFiles,
    textureCount,
    materialCount,
    modelEntries
  };
}

function selectArchive(archiveId) {
  const archive = getArchiveById(archiveId);
  if (!archive) {
    return;
  }

  state.selectedArchiveId = archive.id;
  renderArchiveList();
  renderArchiveDetails();

  if (archive.status === 'ready') {
    loadSelectedArchive();
  } else if (archive.status === 'indexing' || archive.status === 'queued') {
    cancelCurrentLoad();
    showEmptyView(
      'Indexing in progress',
      `${archive.name} is still being indexed. The model will load as soon as the source is ready.`
    );
  } else {
    cancelCurrentLoad();
    showEmptyView('Invalid source', archive.errorMessage || 'This source could not be loaded.');
  }
}

function selectArchiveModel(archiveId, modelPath) {
  const archive = getArchiveById(archiveId);
  if (!archive || archive.status !== 'ready') {
    return;
  }

  archive.selectedModelPath = modelPath;
  renderArchiveDetails();
  renderArchiveList();
  queueThumbnailGeneration(archive);

  if (archive.id === state.selectedArchiveId) {
    loadSelectedArchive();
  }
}

async function loadSelectedArchive() {
  const archive = getSelectedArchive();
  if (!archive || archive.status !== 'ready') {
    return;
  }

  const modelPath = archive.selectedModelPath || archive.modelEntries[0]?.path;
  if (!modelPath) {
    showEmptyView('No model found', 'This source does not contain any loadable model.');
    return;
  }

  if (
    archive.id === state.currentArchiveId &&
    modelPath === state.currentModelPath &&
    state.currentPresentationRoot
  ) {
    fitCameraToObject(state.currentPresentationRoot);
    return;
  }

  const requestId = ++state.loadRequestId;
  cancelCurrentPresentationOnly();
  dom.hud.classList.add('hidden');
  setLoading(`Loading ${getDisplayLabelForModel(archive, modelPath)}...`);
  showEmptyView(
    'Loading model',
    'Extracting local assets and resolving texture references.'
  );

  try {
    const assetPack = await buildPresentationForArchive(archive, modelPath);
    if (!isLoadCurrent(requestId)) {
      assetPack.dispose();
      return;
    }

    await ensureObjectTexturesReady(assetPack.sourceObject);
    if (!isLoadCurrent(requestId)) {
      assetPack.dispose();
      return;
    }

    state.currentArchiveId = archive.id;
    state.currentModelPath = modelPath;
    state.currentSourceObject = assetPack.sourceObject;
    state.currentPresentationRoot = assetPack.presentationRoot;
    state.currentDispose = assetPack.dispose;
    state.currentAnimations = assetPack.animations;
    state.currentStats = assetPack.meta.stats;
    state.animationsPlaying = true;

    if (assetPack.animations.length > 0) {
      state.currentMixer = new THREE.AnimationMixer(assetPack.sourceObject);
      for (const clip of assetPack.animations) {
        state.currentMixer.clipAction(clip).play();
      }
      state.currentMixer.timeScale = 1;
    }

    prepareRenderModeState(assetPack.sourceObject);
    applyRenderModeToObject(assetPack.sourceObject, state.renderMode);
    scene.add(assetPack.presentationRoot);
    fitCameraToObject(assetPack.presentationRoot);
    updateHud(assetPack.meta);
    hideEmptyView();
    dom.hud.classList.remove('hidden');
    queueThumbnailGeneration(archive);
    showStatus(`Model loaded: ${assetPack.meta.modelLabel}.`, 'success');
  } catch (error) {
    if (!isLoadCurrent(requestId)) {
      return;
    }

    const message = cleanupErrorMessage(error.message);
    showEmptyView('Unable to load model', message);
    dom.hud.classList.add('hidden');
    showStatus(`Unable to load ${archive.name}: ${message}`, 'error', {
      sticky: true
    });
  } finally {
    if (isLoadCurrent(requestId)) {
      clearLoading();
      updateToolbarState();
    }
  }
}

async function buildPresentationForArchive(archive, modelPath) {
  const bundle = await getArchiveAssetBundle(archive);
  const normalizedModelPath = resolveModelPath(bundle, modelPath);

  if (!normalizedModelPath || !bundle.filesByPath.has(normalizedModelPath)) {
    throw new Error('The selected model could not be found in this source.');
  }

  archive.cacheAccessAt = Date.now();

  const urlStore = new ObjectUrlRegistry();
  const resolver = createAssetResolver(bundle, urlStore);
  const manager = new THREE.LoadingManager();

  await attachTextureHandlers(manager);

  manager.setURLModifier((requestedUrl) => {
    if (isSpecialUrl(requestedUrl)) {
      return requestedUrl;
    }
    return resolver.toObjectUrl(requestedUrl);
  });

  const modelEntry = bundle.filesByPath.get(normalizedModelPath);
  const modelUrl = urlStore.create(modelEntry.blob);
  const modelDir = getDirectoryPath(normalizedModelPath);
  const resourcePath = modelDir ? `${modelDir}/` : '';

  let sourceObject;
  let animations = [];

  if (modelEntry.extension === 'fbx') {
    const FBXLoader = await getFBXLoaderClass();
    const loader = new FBXLoader(manager);
    if (resourcePath && typeof loader.setResourcePath === 'function') {
      loader.setResourcePath(resourcePath);
    }
    sourceObject = await loader.loadAsync(modelUrl);
    animations = sourceObject.animations || [];
  } else if (modelEntry.extension === 'glb' || modelEntry.extension === 'gltf') {
    const GLTFLoader = await getGLTFLoaderClass();
    const loader = new GLTFLoader(manager);
    if (resourcePath && typeof loader.setResourcePath === 'function') {
      loader.setResourcePath(resourcePath);
    }
    const gltf = await loader.loadAsync(modelUrl);
    sourceObject = gltf.scene;
    animations = gltf.animations || [];
  } else if (modelEntry.extension === 'obj') {
    const OBJLoader = await getOBJLoaderClass();
    const loader = new OBJLoader(manager);
    if (resourcePath && typeof loader.setResourcePath === 'function') {
      loader.setResourcePath(resourcePath);
    }

    const mtlEntry = await findObjMaterialEntry(bundle, modelEntry);
    if (mtlEntry) {
      const MTLLoader = await getMTLLoaderClass();
      const mtlLoader = new MTLLoader(manager);
      const mtlDir = getDirectoryPath(mtlEntry.path);

      if (mtlDir && typeof mtlLoader.setResourcePath === 'function') {
        mtlLoader.setResourcePath(`${mtlDir}/`);
      } else if (resourcePath && typeof mtlLoader.setResourcePath === 'function') {
        mtlLoader.setResourcePath(resourcePath);
      }

      const mtlUrl = urlStore.create(mtlEntry.blob);
      const materials = await mtlLoader.loadAsync(mtlUrl);
      materials.preload();
      loader.setMaterials(materials);
    }

    sourceObject = await loader.loadAsync(modelUrl);
  } else {
    throw new Error(`Unsupported format: ${modelEntry.extension.toUpperCase()}.`);
  }

  if (!sourceObject) {
    throw new Error('The loader returned no 3D object.');
  }

  normalizeLoadedMaterials(sourceObject);
  const presentationRoot = buildPresentationRoot(sourceObject);
  const stats = collectSceneStats(sourceObject);
  const modelLabel = getDisplayLabelForModel(archive, normalizedModelPath);

  return {
    sourceObject,
    presentationRoot,
    animations,
    meta: {
      archiveName: archive.name,
      modelLabel,
      formatLabel: modelEntry.extension.toUpperCase(),
      stats,
      animationCount: animations.length
    },
    dispose() {
      disposeObject3D(presentationRoot);
      urlStore.revokeAll();
    }
  };
}

function buildPresentationRoot(sourceObject) {
  const root = new THREE.Group();
  const scaleWrapper = new THREE.Group();
  const centerWrapper = new THREE.Group();

  root.add(scaleWrapper);
  scaleWrapper.add(centerWrapper);
  centerWrapper.add(sourceObject);

  const sourceBox = new THREE.Box3().setFromObject(sourceObject);
  if (sourceBox.isEmpty()) {
    throw new Error('The model contains no visible geometry.');
  }

  const sourceSize = sourceBox.getSize(new THREE.Vector3());
  const sourceCenter = sourceBox.getCenter(new THREE.Vector3());
  centerWrapper.position.copy(sourceCenter).multiplyScalar(-1);

  const maxDimension = Math.max(sourceSize.x, sourceSize.y, sourceSize.z, 1);
  const scale = Number.isFinite(maxDimension) && maxDimension > 0
    ? TARGET_VIEW_SIZE / maxDimension
    : 1;
  scaleWrapper.scale.setScalar(scale);

  return root;
}

function fitCameraToObject(object) {
  if (!camera || !controls) {
    return;
  }

  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) {
    return;
  }

  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, 1);
  const verticalFov = THREE.MathUtils.degToRad(camera.fov);
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
  const distanceForHeight = radius / Math.sin(verticalFov / 2);
  const distanceForWidth = radius / Math.sin(horizontalFov / 2);
  const distance = Math.max(distanceForHeight, distanceForWidth) * 1.16;

  camera.position.copy(sphere.center).addScaledVector(CAMERA_DIRECTION, distance);
  camera.near = Math.max(radius / 100, 0.1);
  camera.far = Math.max(radius * 40, 1000);
  camera.updateProjectionMatrix();

  controls.target.copy(sphere.center);
  controls.update();
}

function updateHud(meta) {
  const summaryParts = [
    `${pluralize(meta.stats.meshes, 'mesh', 'meshes')}`,
    `${formatInteger(meta.stats.triangles)} triangles`,
    `${pluralize(meta.stats.materials, 'material', 'materials')}`
  ];

  if (meta.animationCount > 0) {
    summaryParts.push(`${pluralize(meta.animationCount, 'animation', 'animations')}`);
  }

  dom.hudFormat.textContent = `${meta.formatLabel} | ${meta.archiveName}`;
  dom.hudTitle.textContent = meta.modelLabel;
  dom.hudSubtitle.textContent = summaryParts.join(' | ');
  updateToolbarState();
}

async function exportCurrentModelAsGlb() {
  if (!state.currentSourceObject) {
    return;
  }

  dom.exportBtn.disabled = true;
  dom.exportBtn.textContent = 'Export...';

  try {
    const GLTFExporter = await getGLTFExporterClass();
    const exporter = new GLTFExporter();
    const glbBuffer = await new Promise((resolve, reject) => {
      exporter.parse(
        state.currentSourceObject,
        (result) => resolve(result),
        (error) => reject(error),
        {
          binary: true,
          animations: state.currentAnimations
        }
      );
    });

    const buffer = glbBuffer instanceof ArrayBuffer
      ? glbBuffer
      : glbBuffer.buffer.slice(glbBuffer.byteOffset, glbBuffer.byteOffset + glbBuffer.byteLength);
    const blob = new Blob([buffer], { type: 'model/gltf-binary' });
    const baseName = slugify(getBaseName(state.currentModelPath || state.currentArchiveId || 'model'));
    downloadBlob(blob, `${baseName || 'model'}.glb`);
    showStatus('GLB export completed.', 'success');
  } catch (error) {
    console.error('Export failed:', error);
    showStatus(`Export failed: ${cleanupErrorMessage(error.message)}`, 'error', {
      sticky: true
    });
  } finally {
    dom.exportBtn.textContent = 'Export GLB';
    updateToolbarState();
  }
}

function updateToolbarState() {
  const hasModel = Boolean(state.currentSourceObject && state.currentPresentationRoot);
  const hasAnimations = Boolean(state.currentMixer && state.currentAnimations.length > 0);
  const modeButtons = [
    [dom.viewLitBtn, 'lit'],
    [dom.viewUnlitBtn, 'unlit'],
    [dom.viewWireframeBtn, 'wireframe']
  ];

  dom.resetCamBtn.disabled = !hasModel;
  dom.exportBtn.disabled = !hasModel;
  dom.toggleGridBtn.disabled = !gridHelper;
  dom.toggleGridBtn.setAttribute('aria-pressed', String(state.gridVisible));
  dom.toggleGridBtn.textContent = state.gridVisible ? 'Grid On' : 'Grid Off';

  dom.toggleAnimBtn.classList.toggle('hidden', !hasAnimations);
  dom.toggleAnimBtn.disabled = !hasAnimations;
  dom.toggleAnimBtn.setAttribute('aria-pressed', String(state.animationsPlaying));
  dom.toggleAnimBtn.textContent = state.animationsPlaying ? 'Animation On' : 'Animation Off';

  for (const [button, mode] of modeButtons) {
    button.disabled = !hasModel;
    button.setAttribute('aria-pressed', String(hasModel && state.renderMode === mode));
    button.classList.toggle('active', hasModel && state.renderMode === mode);
  }
}

function renderArchiveList() {
  dom.archiveList.textContent = '';
  dom.libraryCount.textContent = pluralize(state.archives.length, 'item');
  dom.clearBtn.disabled = state.archives.length === 0;

  if (state.archives.length === 0) {
    const emptyItem = document.createElement('li');
    emptyItem.className = 'empty-list';
    emptyItem.textContent = getEmptyLibraryMessage();
    dom.archiveList.appendChild(emptyItem);
    return;
  }

  for (const archive of state.archives) {
    const listItem = document.createElement('li');
    const wrap = document.createElement('div');
    wrap.className = 'archive-card-wrap';

    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'archive-card';
    card.classList.toggle('active', archive.id === state.selectedArchiveId);
    card.setAttribute('aria-selected', String(archive.id === state.selectedArchiveId));
    card.setAttribute('title', archive.name);
    card.addEventListener('click', () => selectArchive(archive.id));

    const thumb = document.createElement('div');
    thumb.className = 'archive-thumb';

    if (archive.thumbnail) {
      const image = document.createElement('img');
      image.src = archive.thumbnail;
      image.alt = '';
      thumb.appendChild(image);
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'archive-thumb-placeholder';
      const badge = document.createElement('strong');
      badge.textContent = getArchiveFormatBadge(archive);
      placeholder.appendChild(badge);
      thumb.appendChild(placeholder);
    }

    const content = document.createElement('div');
    content.className = 'archive-content';

    const title = document.createElement('h3');
    title.textContent = archive.name;
    content.appendChild(title);

    const summary = document.createElement('p');
    summary.className = 'card-summary';
    summary.textContent = describeArchiveSummary(archive);
    content.appendChild(summary);

    const footer = document.createElement('div');
    footer.className = 'card-footer';

    const statusChip = document.createElement('span');
    statusChip.className = `status-chip ${getArchiveStatusTone(archive.status)}`;
    statusChip.textContent = getArchiveStatusLabel(archive.status);
    footer.appendChild(statusChip);

    const formatNote = document.createElement('span');
    formatNote.textContent = buildArchiveFooterNote(archive);
    footer.appendChild(formatNote);

    content.appendChild(footer);
    card.append(thumb, content);

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'archive-remove';
    removeButton.setAttribute('aria-label', `Remove ${archive.name}`);
    removeButton.textContent = 'x';
    removeButton.addEventListener('click', (event) => {
      event.stopPropagation();
      removeArchive(archive.id);
    });

    wrap.append(card, removeButton);
    listItem.appendChild(wrap);
    dom.archiveList.appendChild(listItem);
  }
}

function renderArchiveDetails() {
  const archive = getSelectedArchive();

  if (!archive) {
    dom.archiveMeta.classList.add('hidden');
    dom.inspectorToggle.disabled = true;
    setInspectorOpen(false);
    syncInspectorState();
    return;
  }

  dom.archiveMeta.classList.remove('hidden');
  dom.inspectorToggle.disabled = false;
  dom.archiveMetaTitle.textContent = archive.name;
  dom.archiveMetaBadge.textContent = getArchiveFormatBadge(archive);
  dom.archiveSummary.textContent = describeArchiveSummary(archive);
  dom.metaFiles.textContent = archive.totalFiles > 0 ? formatInteger(archive.totalFiles) : '-';
  dom.metaTextures.textContent = archive.textureCount > 0 ? formatInteger(archive.textureCount) : '0';
  dom.metaMaterials.textContent = archive.materialCount > 0 ? formatInteger(archive.materialCount) : '0';
  dom.metaSize.textContent = formatBytes(archive.size);
  dom.modelCount.textContent = formatInteger(archive.modelEntries.length);

  dom.modelList.textContent = '';

  if (archive.status === 'ready' && archive.modelEntries.length > 0) {
    for (const modelEntry of archive.modelEntries) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'model-btn';
      button.classList.toggle('active', archive.selectedModelPath === modelEntry.path);
      button.setAttribute('aria-pressed', String(archive.selectedModelPath === modelEntry.path));
      button.addEventListener('click', () => selectArchiveModel(archive.id, modelEntry.path));

      const label = document.createElement('span');
      label.className = 'model-btn-label';
      label.textContent = modelEntry.label;

      const extension = document.createElement('span');
      extension.className = 'pill';
      extension.textContent = modelEntry.extension.toUpperCase();

      button.append(label, extension);
      item.appendChild(button);
      dom.modelList.appendChild(item);
    }
  } else {
    const placeholder = document.createElement('li');
    placeholder.className = 'empty-list';
    placeholder.textContent = archive.status === 'error'
      ? archive.errorMessage
      : 'Models will appear here once indexing is complete.';
    dom.modelList.appendChild(placeholder);
  }

  syncInspectorState();
}

function removeArchive(archiveId) {
  const archive = getArchiveById(archiveId);
  if (!archive) {
    return;
  }

  archive.removed = true;
  clearArchiveCache(archive);
  state.thumbnailQueue = state.thumbnailQueue.filter((entry) => entry.id !== archiveId);
  state.indexQueue = state.indexQueue.filter((entry) => entry.id !== archiveId);

  if (state.selectedArchiveId === archiveId) {
    state.selectedArchiveId = null;
  }

  if (state.currentArchiveId === archiveId) {
    cancelCurrentLoad();
  }

  state.archives = state.archives.filter((entry) => entry.id !== archiveId);
  renderArchiveList();
  renderArchiveDetails();
  selectFirstReadyArchiveIfNeeded();

  if (state.archives.length === 0) {
    showInitialEmptyState();
  }
}

function clearLibrary() {
  if (state.archives.length === 0) {
    return;
  }

  for (const archive of state.archives) {
    archive.removed = true;
    clearArchiveCache(archive);
  }

  cancelCurrentLoad();
  state.archives = [];
  state.selectedArchiveId = null;
  state.indexQueue = [];
  state.thumbnailQueue = [];
  renderArchiveList();
  renderArchiveDetails();
  showInitialEmptyState();
  showStatus('Library cleared.', 'info');
}

function cancelCurrentLoad() {
  state.loadRequestId += 1;
  clearLoading();
  cancelCurrentPresentationOnly();
  dom.hud.classList.add('hidden');
  updateToolbarState();
}

function cancelCurrentPresentationOnly() {
  if (state.currentPresentationRoot && scene) {
    scene.remove(state.currentPresentationRoot);
  }

  if (state.currentMixer && state.currentSourceObject) {
    state.currentMixer.stopAllAction();
    state.currentMixer.uncacheRoot(state.currentSourceObject);
  }

  if (state.currentDispose) {
    state.currentDispose();
  }

  state.currentArchiveId = null;
  state.currentModelPath = null;
  state.currentSourceObject = null;
  state.currentPresentationRoot = null;
  state.currentMixer = null;
  state.currentAnimations = [];
  state.currentDispose = null;
  state.currentStats = null;
  state.animationsPlaying = true;
}

function selectFirstReadyArchiveIfNeeded() {
  if (state.selectedArchiveId && getSelectedArchive()) {
    return;
  }

  const firstReadyArchive = state.archives.find((archive) => archive.status === 'ready');
  if (firstReadyArchive) {
    selectArchive(firstReadyArchive.id);
    return;
  }

  if (state.archives.length === 0) {
    dom.archiveMeta.classList.add('hidden');
  }
}

function getSelectedArchive() {
  return getArchiveById(state.selectedArchiveId);
}

function getArchiveById(archiveId) {
  return state.archives.find((archive) => archive.id === archiveId) || null;
}

function isArchiveTracked(archiveId) {
  return Boolean(getArchiveById(archiveId));
}

function setInspectorOpen(open) {
  state.inspectorOpen = Boolean(open && getSelectedArchive());
  syncInspectorState();
}

function syncInspectorState() {
  const hasArchive = Boolean(getSelectedArchive());
  dom.inspectorToggle.classList.toggle('hidden', !hasArchive);
  dom.inspectorToggle.disabled = !hasArchive;
  dom.inspectorToggle.setAttribute('aria-expanded', String(hasArchive && state.inspectorOpen));
  dom.inspectorToggle.textContent = hasArchive && state.inspectorOpen ? 'Hide Inspector' : 'Inspector';
  dom.archiveMeta.classList.toggle('collapsed', !state.inspectorOpen);
}

async function getArchiveAssetBundle(archive) {
  if (archive.assetBundle) {
    archive.cacheAccessAt = Date.now();
    return archive.assetBundle;
  }

  if (archive.assetBundlePromise) {
    return archive.assetBundlePromise;
  }

  archive.assetBundlePromise = buildArchiveAssetBundle(archive)
    .then((bundle) => {
      archive.assetBundle = bundle;
      archive.assetBundleBytes = bundle.totalBytes;
      archive.cacheAccessAt = Date.now();
      archive.assetBundlePromise = null;
      enforceAssetCacheBudget();
      return bundle;
    })
    .catch((error) => {
      archive.assetBundlePromise = null;
      throw error;
    });

  return archive.assetBundlePromise;
}

async function buildArchiveAssetBundle(archive) {
  if (archive.sourceType === 'directory') {
    const snapshot = archive.directorySnapshot ?? await scanDirectoryHandle(archive.sourceHandle);
    archive.directorySnapshot = snapshot;
    archive.size = snapshot.totalBytes;

    const filesByPath = new Map();
    const filesByName = new Map();
    let totalBytes = 0;

    const relevantEntries = snapshot.entries.filter((entry) => RELEVANT_ARCHIVE_EXTENSIONS.has(entry.extension));
    const files = await Promise.all(
      relevantEntries.map(async (entry) => {
        const file = await entry.handle.getFile();
        return { entry, file };
      })
    );

    for (const { entry, file } of files) {
      const bundleEntry = {
        path: entry.path,
        name: entry.name,
        blob: file,
        extension: entry.extension
      };

      totalBytes += file.size;
      filesByPath.set(bundleEntry.path, bundleEntry);

      const existingByName = filesByName.get(bundleEntry.name) || [];
      existingByName.push(bundleEntry);
      filesByName.set(bundleEntry.name, existingByName);
    }

    return {
      filesByPath,
      filesByName,
      totalBytes
    };
  }

  if (archive.sourceType !== 'zip') {
    const normalizedPath = normalizeArchivePath(archive.name);
    const entry = {
      path: normalizedPath,
      name: getBaseName(normalizedPath),
      blob: archive.sourceFile,
      extension: archive.uploadExtension
    };

    return {
      filesByPath: new Map([[normalizedPath, entry]]),
      filesByName: new Map([[entry.name, [entry]]]),
      totalBytes: archive.sourceFile.size
    };
  }

  const JSZip = await getJSZip();
  const zipContent = await JSZip.loadAsync(archive.sourceFile);
  const filesByPath = new Map();
  const filesByName = new Map();
  const extractionJobs = [];
  let totalBytes = 0;

  zipContent.forEach((relativePath, zipEntry) => {
    if (zipEntry.dir) {
      return;
    }

    const normalizedPath = normalizeArchivePath(relativePath);
    const extension = getFileExtension(normalizedPath);

    if (!RELEVANT_ARCHIVE_EXTENSIONS.has(extension)) {
      return;
    }

    extractionJobs.push(
      zipEntry.async('blob').then((blob) => {
        const entry = {
          path: normalizedPath,
          name: getBaseName(normalizedPath),
          blob,
          extension
        };

        totalBytes += blob.size;
        filesByPath.set(normalizedPath, entry);

        const existingByName = filesByName.get(entry.name) || [];
        existingByName.push(entry);
        filesByName.set(entry.name, existingByName);
      })
    );
  });

  await Promise.all(extractionJobs);

  return {
    filesByPath,
    filesByName,
    totalBytes
  };
}

async function scanDirectoryHandle(rootHandle, options = {}) {
  const { requireDirectModel = true } = options;
  const entries = [];
  const modelEntries = [];
  const zipEntries = [];
  let totalFiles = 0;
  let totalBytes = 0;
  let textureCount = 0;
  let materialCount = 0;

  async function walk(handle, prefix = '') {
    for await (const [name, childHandle] of handle.entries()) {
      const relativePath = prefix ? `${prefix}/${name}` : name;

      if (childHandle.kind === 'directory') {
        await walk(childHandle, relativePath);
        continue;
      }

      totalFiles += 1;

      const normalizedPath = normalizeArchivePath(relativePath);
      const extension = getFileExtension(normalizedPath);
      const file = await childHandle.getFile();

      totalBytes += file.size;

      const entry = {
        path: normalizedPath,
        label: relativePath.replace(/\\/g, '/'),
        name: getBaseName(normalizedPath),
        extension,
        handle: childHandle,
        size: file.size
      };

      entries.push(entry);

      if (MODEL_EXTENSIONS.has(extension)) {
        modelEntries.push({
          path: entry.path,
          label: entry.label,
          extension: entry.extension
        });
      }

      if (extension === 'zip') {
        zipEntries.push(entry);
      }

      if (TEXTURE_EXTENSIONS.has(extension)) {
        textureCount += 1;
      }

      if (MATERIAL_EXTENSIONS.has(extension)) {
        materialCount += 1;
      }
    }
  }

  await walk(rootHandle);

  if (requireDirectModel && modelEntries.length === 0) {
    throw new Error('No supported FBX, GLB, GLTF or OBJ model was found in this folder.');
  }

  modelEntries.sort((left, right) => {
    const lengthDelta = left.label.length - right.label.length;
    return lengthDelta !== 0 ? lengthDelta : left.label.localeCompare(right.label);
  });

  return {
    entries,
    totalFiles,
    totalBytes,
    textureCount,
    materialCount,
    modelEntries,
    zipEntries
  };
}

function clearArchiveCache(archive) {
  archive.assetBundle = null;
  archive.assetBundlePromise = null;
  archive.assetBundleBytes = 0;
  archive.cacheAccessAt = 0;
}

function enforceAssetCacheBudget() {
  const cachedArchives = state.archives
    .filter((archive) => archive.assetBundle)
    .sort((left, right) => left.cacheAccessAt - right.cacheAccessAt);

  let totalBytes = cachedArchives.reduce((sum, archive) => sum + archive.assetBundleBytes, 0);

  while (cachedArchives.length > CACHE_LIMIT_ARCHIVES || totalBytes > CACHE_LIMIT_BYTES) {
    const oldestArchive = cachedArchives.shift();
    if (!oldestArchive) {
      break;
    }

    if (oldestArchive.id === state.selectedArchiveId && cachedArchives.length > 0) {
      cachedArchives.push(oldestArchive);
      continue;
    }

    totalBytes -= oldestArchive.assetBundleBytes;
    clearArchiveCache(oldestArchive);
  }
}

function queueThumbnailGeneration(archive) {
  if (!thumbRenderer || archive.status !== 'ready' || !archive.selectedModelPath) {
    return;
  }

  if (archive.thumbnailKey === archive.selectedModelPath && archive.thumbnail) {
    return;
  }

  archive.thumbnailStatus = 'queued';
  state.thumbnailQueue = state.thumbnailQueue.filter((entry) => entry.id !== archive.id);
  state.thumbnailQueue.push(archive);
  processThumbnailQueue();
}

async function processThumbnailQueue() {
  if (state.isGeneratingThumbnail || state.thumbnailQueue.length === 0 || !thumbRenderer) {
    return;
  }

  state.isGeneratingThumbnail = true;

  while (state.thumbnailQueue.length > 0) {
    const archive = state.thumbnailQueue.shift();
    if (!archive || archive.removed || archive.status !== 'ready' || !archive.selectedModelPath) {
      continue;
    }

    const targetModelPath = archive.selectedModelPath;
    archive.thumbnailStatus = 'loading';
    renderArchiveList();

    try {
      const assetPack = await buildPresentationForArchive(archive, targetModelPath);
      if (!isArchiveTracked(archive.id) || archive.selectedModelPath !== targetModelPath) {
        assetPack.dispose();
        continue;
      }

      await ensureObjectTexturesReady(assetPack.sourceObject);
      archive.thumbnail = await renderThumbnail(assetPack.presentationRoot);
      archive.thumbnailKey = targetModelPath;
      archive.thumbnailStatus = 'ready';
      assetPack.dispose();
    } catch (error) {
      console.error('Thumbnail generation failed:', error);
      archive.thumbnailStatus = 'error';
    }

    renderArchiveList();
  }

  state.isGeneratingThumbnail = false;
}

async function renderThumbnail(object) {
  thumbScene.add(object);
  const box = new THREE.Box3().setFromObject(object);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, 1);
  const distance = radius * 2.5;

  thumbCamera.position.copy(sphere.center).addScaledVector(CAMERA_DIRECTION, distance);
  thumbCamera.near = Math.max(radius / 50, 0.1);
  thumbCamera.far = Math.max(radius * 20, 500);
  thumbCamera.lookAt(sphere.center);
  thumbCamera.updateProjectionMatrix();

  thumbRenderer.compile(thumbScene, thumbCamera);
  await waitForNextFrame();
  thumbRenderer.render(thumbScene, thumbCamera);
  await waitForDelay(90);
  thumbRenderer.render(thumbScene, thumbCamera);
  const dataUrl = thumbRenderer.domElement.toDataURL('image/jpeg', 0.88);
  thumbScene.remove(object);
  return dataUrl;
}

async function findObjMaterialEntry(bundle, modelEntry) {
  const objText = await modelEntry.blob.text();
  const materialReferences = extractObjMaterialReferences(objText);
  const modelDirectory = getDirectoryPath(modelEntry.path);

  for (const materialRef of materialReferences) {
    const exactPath = normalizeArchivePath(
      modelDirectory ? `${modelDirectory}/${materialRef}` : materialRef
    );
    if (bundle.filesByPath.has(exactPath)) {
      return bundle.filesByPath.get(exactPath);
    }

    const byName = bundle.filesByName.get(getBaseName(materialRef));
    if (byName && byName.length > 0) {
      return byName[0];
    }
  }

  return null;
}

function extractObjMaterialReferences(objText) {
  const references = [];
  const lines = objText.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    if (trimmed.toLowerCase().startsWith('mtllib ')) {
      references.push(trimmed.slice(7).trim());
    }
  }

  return references;
}

function resolveModelPath(bundle, rawPath) {
  const normalizedPath = normalizeArchivePath(rawPath);
  if (bundle.filesByPath.has(normalizedPath)) {
    return normalizedPath;
  }

  const byName = bundle.filesByName.get(getBaseName(normalizedPath));
  return byName?.[0]?.path || null;
}

function createAssetResolver(bundle, urlStore) {
  return {
    findEntry(requestedUrl) {
      const normalizedPath = normalizeArchivePath(requestedUrl);
      if (!normalizedPath) {
        return null;
      }

      if (bundle.filesByPath.has(normalizedPath)) {
        return bundle.filesByPath.get(normalizedPath);
      }

      const byName = bundle.filesByName.get(getBaseName(normalizedPath));
      if (!byName || byName.length === 0) {
        return null;
      }

      if (byName.length === 1) {
        return byName[0];
      }

      return byName.find((entry) => entry.path.endsWith(normalizedPath)) || byName[0];
    },

    toObjectUrl(requestedUrl) {
      const entry = this.findEntry(requestedUrl);
      return entry ? urlStore.create(entry.blob) : requestedUrl;
    }
  };
}

class ObjectUrlRegistry {
  constructor() {
    this.urls = new Set();
  }

  create(blob) {
    const url = URL.createObjectURL(blob);
    this.urls.add(url);
    return url;
  }

  revokeAll() {
    for (const url of this.urls) {
      URL.revokeObjectURL(url);
    }
    this.urls.clear();
  }
}

function disposeObject3D(object) {
  object.traverse((child) => {
    if (child.geometry) {
      child.geometry.dispose();
    }

    if (!child.material && !child.userData.__viewerOriginalMaterial) {
      return;
    }

    const materialsToDispose = new Set();
    const currentMaterials = child.material
      ? (Array.isArray(child.material) ? child.material : [child.material])
      : [];
    const originalMaterials = child.userData.__viewerOriginalMaterial
      ? (Array.isArray(child.userData.__viewerOriginalMaterial)
        ? child.userData.__viewerOriginalMaterial
        : [child.userData.__viewerOriginalMaterial])
      : [];

    for (const material of [...currentMaterials, ...originalMaterials]) {
      materialsToDispose.add(material);
    }

    for (const material of materialsToDispose) {
      disposeMaterial(material);
    }
  });
}

function disposeMaterial(material) {
  if (!material) {
    return;
  }

  const skipTextureDispose = Boolean(material.userData?.__viewerSkipTextureDispose);
  for (const value of Object.values(material)) {
    if (!skipTextureDispose && value && value.isTexture) {
      value.dispose();
    }
  }
  material.dispose();
}

function collectSceneStats(object) {
  const materialIds = new Set();
  let meshes = 0;
  let triangles = 0;
  let vertices = 0;

  object.traverse((child) => {
    if (!child.isMesh) {
      return;
    }

    meshes += 1;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (material?.uuid) {
        materialIds.add(material.uuid);
      }
    }

    const positionAttribute = child.geometry?.attributes?.position;
    const indexAttribute = child.geometry?.index;

    if (positionAttribute) {
      vertices += positionAttribute.count;
    }

    if (indexAttribute) {
      triangles += Math.floor(indexAttribute.count / 3);
    } else if (positionAttribute) {
      triangles += Math.floor(positionAttribute.count / 3);
    }
  });

  return {
    meshes,
    triangles,
    vertices,
    materials: materialIds.size
  };
}

function normalizeLoadedMaterials(object) {
  object.traverse((child) => {
    if (!child.material) {
      return;
    }

    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (material.map) {
        material.map.colorSpace = THREE.SRGBColorSpace;
      }

      if (material.emissiveMap) {
        material.emissiveMap.colorSpace = THREE.SRGBColorSpace;
      }

      material.needsUpdate = true;
    }
  });
}

function prepareRenderModeState(object) {
  object.traverse((child) => {
    if (!child.isMesh || !child.material) {
      return;
    }

    child.userData.__viewerOriginalMaterial = child.material;
    child.userData.__viewerDerivedMaterial = null;
  });
}

function setRenderMode(mode) {
  if (state.renderMode === mode) {
    return;
  }

  state.renderMode = mode;

  if (state.currentSourceObject) {
    applyRenderModeToObject(state.currentSourceObject, mode);
  }

  updateToolbarState();
}

function applyRenderModeToObject(object, mode) {
  object.traverse((child) => {
    if (!child.isMesh || !child.userData.__viewerOriginalMaterial) {
      return;
    }

    disposeDerivedMaterial(child);

    if (mode === 'lit') {
      child.material = child.userData.__viewerOriginalMaterial;
      return;
    }

    const originalMaterial = child.userData.__viewerOriginalMaterial;
    const originalMaterials = Array.isArray(originalMaterial) ? originalMaterial : [originalMaterial];
    const derivedMaterials = originalMaterials.map((material) => createMaterialForMode(material, child, mode));
    const nextMaterial = Array.isArray(originalMaterial) ? derivedMaterials : derivedMaterials[0];

    child.userData.__viewerDerivedMaterial = nextMaterial;
    child.material = nextMaterial;
  });
}

function createMaterialForMode(originalMaterial, mesh, mode) {
  if (mode === 'wireframe') {
    const material = originalMaterial.clone();
    material.wireframe = true;
    material.transparent = true;
    material.opacity = originalMaterial.opacity ?? 1;
    material.userData.__viewerSkipTextureDispose = true;
    material.needsUpdate = true;
    return material;
  }

  const material = new THREE.MeshBasicMaterial({
    name: `${originalMaterial.name || 'material'}-unlit`,
    color: originalMaterial.color?.clone?.() ?? new THREE.Color(0xffffff),
    map: originalMaterial.map ?? null,
    alphaMap: originalMaterial.alphaMap ?? null,
    aoMap: originalMaterial.aoMap ?? null,
    envMap: originalMaterial.envMap ?? null,
    lightMap: originalMaterial.lightMap ?? null,
    specularMap: originalMaterial.specularMap ?? null,
    transparent: originalMaterial.transparent ?? false,
    opacity: originalMaterial.opacity ?? 1,
    side: originalMaterial.side ?? THREE.FrontSide,
    fog: false,
    wireframe: false
  });

  material.vertexColors = originalMaterial.vertexColors ?? false;
  material.skinning = mesh.isSkinnedMesh;
  material.morphTargets = Boolean(mesh.morphTargetInfluences?.length);
  material.toneMapped = false;
  material.userData.__viewerSkipTextureDispose = true;
  material.needsUpdate = true;
  return material;
}

function disposeDerivedMaterial(mesh) {
  const derived = mesh.userData.__viewerDerivedMaterial;
  if (!derived) {
    return;
  }

  const materials = Array.isArray(derived) ? derived : [derived];
  for (const material of materials) {
    disposeMaterial(material);
  }

  mesh.userData.__viewerDerivedMaterial = null;
}

async function ensureObjectTexturesReady(object) {
  const textures = new Set();

  object.traverse((child) => {
    if (!child.material) {
      return;
    }

    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value && value.isTexture) {
          textures.add(value);
        }
      }
    }
  });

  await Promise.all(Array.from(textures, waitForTextureReady));
}

function waitForTextureReady(texture) {
  const sourceData = texture?.source?.data;

  if (!sourceData) {
    return Promise.resolve();
  }

  if (typeof ImageBitmap !== 'undefined' && sourceData instanceof ImageBitmap) {
    texture.needsUpdate = true;
    return Promise.resolve();
  }

  if (typeof HTMLCanvasElement !== 'undefined' && sourceData instanceof HTMLCanvasElement) {
    texture.needsUpdate = true;
    return Promise.resolve();
  }

  if (typeof OffscreenCanvas !== 'undefined' && sourceData instanceof OffscreenCanvas) {
    texture.needsUpdate = true;
    return Promise.resolve();
  }

  if (ArrayBuffer.isView(sourceData)) {
    texture.needsUpdate = true;
    return Promise.resolve();
  }

  if (typeof sourceData.complete === 'boolean') {
    if (sourceData.complete) {
      texture.needsUpdate = true;
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        texture.needsUpdate = true;
        resolve();
      };

      sourceData.addEventListener?.('load', finish, { once: true });
      sourceData.addEventListener?.('error', finish, { once: true });
      window.setTimeout(finish, 300);
    });
  }

  texture.needsUpdate = true;
  return Promise.resolve();
}

function waitForNextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function waitForDelay(durationMs) {
  return new Promise((resolve) => window.setTimeout(resolve, durationMs));
}

function showStatus(message, tone = 'info', options = {}) {
  const { sticky = false } = options;

  clearTimeout(state.statusTimer);
  dom.statusBanner.textContent = message;
  dom.statusBanner.className = `status-banner ${tone}`;
  dom.statusBanner.classList.remove('hidden');

  if (!sticky) {
    state.statusTimer = window.setTimeout(() => {
      dom.statusBanner.classList.add('hidden');
      dom.statusBanner.textContent = '';
      dom.statusBanner.className = 'status-banner hidden';
    }, 5000);
  }
}

function setLoading(message) {
  dom.loadingText.textContent = message;
  dom.loadingScreen.classList.remove('hidden');
}

function clearLoading() {
  dom.loadingScreen.classList.add('hidden');
}

function showEmptyView(title, description) {
  dom.emptyTitle.textContent = title;
  dom.emptyDescription.textContent = description;
  dom.emptyView.classList.remove('hidden');
}

function hideEmptyView() {
  dom.emptyView.classList.add('hidden');
}

function isLoadCurrent(requestId) {
  return requestId === state.loadRequestId;
}

function isDuplicateFile(file, archiveName = file.name) {
  return state.archives.some(
    (archive) =>
      archive.sourceFile &&
      archive.name === archiveName &&
      archive.size === file.size &&
      archive.sourceFile.lastModified === file.lastModified
  );
}

function buildImportSkipMessage(skippedUnsupported, skippedDuplicates) {
  const parts = [];
  if (skippedUnsupported > 0) {
    parts.push(
      `${pluralize(skippedUnsupported, 'unsupported file skipped', 'unsupported files skipped')}`
    );
  }

  if (skippedDuplicates > 0) {
    parts.push(
      `${pluralize(skippedDuplicates, 'duplicate skipped', 'duplicates skipped')}`
    );
  }

  return parts.join(' | ');
}

function describeArchiveSummary(archive) {
  if (archive.status === 'queued' || archive.status === 'indexing') {
    return 'Scanning local files and detecting models.';
  }

  if (archive.status === 'error') {
    return archive.errorMessage || 'This source could not be loaded.';
  }

  const parts = [
    pluralize(archive.modelEntries.length, 'model'),
    pluralize(archive.textureCount, 'texture'),
    formatBytes(archive.size)
  ];

  if (archive.sourceType === 'file' && (archive.uploadExtension === 'obj' || archive.uploadExtension === 'gltf')) {
    parts.push('ZIP or folder recommended for external textures');
  }

  return parts.join(' | ');
}

function buildArchiveFooterNote(archive) {
  if (archive.status === 'ready') {
    if (archive.sourceType === 'zip') {
      return `${pluralize(archive.totalFiles, 'file')} in archive`;
    }

    if (archive.sourceType === 'directory') {
      return `${pluralize(archive.totalFiles, 'file')} in folder`;
    }

    return `Standalone ${archive.uploadExtension.toUpperCase()}`;
  }

  if (archive.status === 'error') {
    return 'Validation failed';
  }

  return 'Processing locally';
}

function getArchiveFormatBadge(archive) {
  if (archive.sourceType === 'zip') {
    return 'ZIP';
  }

  if (archive.sourceType === 'directory') {
    return 'DIR';
  }

  return archive.uploadExtension.toUpperCase();
}

function getArchiveStatusLabel(status) {
  if (status === 'ready') {
    return 'Ready';
  }
  if (status === 'error') {
    return 'Error';
  }
  return 'Indexing';
}

function getArchiveStatusTone(status) {
  if (status === 'ready') {
    return 'ready';
  }
  if (status === 'error') {
    return 'error';
  }
  return 'loading';
}

function getDisplayLabelForModel(archive, modelPath) {
  const modelEntry = archive.modelEntries.find((entry) => entry.path === modelPath);
  return modelEntry?.label || getBaseName(modelPath);
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${formatInteger(count)} ${count === 1 ? singular : plural}`;
}

function formatInteger(value) {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const amount = bytes / 1024 ** exponent;
  const digits = amount >= 10 || exponent === 0 ? 0 : 1;
  return `${amount.toFixed(digits)} ${units[exponent]}`;
}

function cleanupErrorMessage(message) {
  return String(message || 'Unknown error.')
    .replace(/\s+/g, ' ')
    .trim();
}

function showInitialEmptyState() {
  showEmptyView(
    'Add a 3D asset source',
    state.supportsDirectoryAccess
      ? 'Drop a ZIP package with a model and its textures, add a standalone 3D file, or mount a local folder.'
      : 'Drop a ZIP package with a model and its textures, then choose it from the library.'
  );
}

function getEmptyLibraryMessage() {
  return state.supportsDirectoryAccess
    ? 'No asset sources loaded. Add files or mount a local folder to begin.'
    : 'No asset sources loaded. Add files to begin.';
}

function normalizeArchivePath(rawPath) {
  if (!rawPath || isSpecialUrl(rawPath)) {
    return rawPath;
  }

  let normalized = rawPath.replace(/\\/g, '/').trim();
  normalized = normalized.split('#')[0].split('?')[0];
  normalized = normalized.replace(/^\.\/+/, '').replace(/^\/+/, '');

  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Ignore malformed escape sequences.
  }

  const segments = [];
  for (const segment of normalized.split('/')) {
    if (!segment || segment === '.') {
      continue;
    }

    if (segment === '..') {
      segments.pop();
      continue;
    }

    segments.push(segment);
  }

  return segments.join('/').toLowerCase();
}

function getDirectoryPath(filePath) {
  const normalizedPath = normalizeArchivePath(filePath);
  const lastSlashIndex = normalizedPath.lastIndexOf('/');
  return lastSlashIndex === -1 ? '' : normalizedPath.slice(0, lastSlashIndex);
}

function getBaseName(filePath) {
  const normalizedPath = normalizeArchivePath(filePath);
  const parts = normalizedPath.split('/');
  return parts[parts.length - 1] || normalizedPath;
}

function getFileExtension(filePath) {
  const baseName = getBaseName(filePath);
  const dotIndex = baseName.lastIndexOf('.');
  return dotIndex === -1 ? '' : baseName.slice(dotIndex + 1).toLowerCase();
}

function isSpecialUrl(value) {
  return /^(blob:|data:|https?:)/i.test(value);
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function attachTextureHandlers(manager) {
  const [TGALoader, DDSLoader] = await Promise.all([
    getTGALoaderClass(),
    getDDSLoaderClass()
  ]);

  manager.addHandler(/\.tga$/i, new TGALoader());
  manager.addHandler(/\.dds$/i, new DDSLoader());
}

function getCachedModule(key, factory) {
  if (!moduleCache[key]) {
    moduleCache[key] = factory();
  }
  return moduleCache[key];
}

async function getJSZip() {
  return (await getCachedModule('jszip', () => import('jszip'))).default;
}

async function getFBXLoaderClass() {
  return (await getCachedModule('fbx-loader', () => import('three/examples/jsm/loaders/FBXLoader.js'))).FBXLoader;
}

async function getGLTFLoaderClass() {
  return (await getCachedModule('gltf-loader', () => import('three/examples/jsm/loaders/GLTFLoader.js'))).GLTFLoader;
}

async function getOBJLoaderClass() {
  return (await getCachedModule('obj-loader', () => import('three/examples/jsm/loaders/OBJLoader.js'))).OBJLoader;
}

async function getMTLLoaderClass() {
  return (await getCachedModule('mtl-loader', () => import('three/examples/jsm/loaders/MTLLoader.js'))).MTLLoader;
}

async function getTGALoaderClass() {
  return (await getCachedModule('tga-loader', () => import('three/examples/jsm/loaders/TGALoader.js'))).TGALoader;
}

async function getDDSLoaderClass() {
  return (await getCachedModule('dds-loader', () => import('three/examples/jsm/loaders/DDSLoader.js'))).DDSLoader;
}

async function getGLTFExporterClass() {
  return (await getCachedModule('gltf-exporter', () => import('three/examples/jsm/exporters/GLTFExporter.js'))).GLTFExporter;
}
