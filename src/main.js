import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import JSZip from 'jszip';

// DOM Elements
const dropOverlay = document.getElementById('drop-overlay');
const fileInput = document.getElementById('file-input');
const browseBtn = document.getElementById('browse-btn');
const zipList = document.getElementById('zip-list');
const viewerContainer = document.getElementById('viewer-container');
const loadingScreen = document.getElementById('loading');
const loadingText = document.getElementById('loading-text');
const hud = document.getElementById('hud');
const hudTitle = document.getElementById('hud-title');
const resetCamBtn = document.getElementById('reset-cam-btn');
const exportBtn = document.getElementById('export-btn');

// State
let loadedArchives = []; // Array of { id, name, file }
let currentArchiveId = null;
let currentObjectURLs = []; // To revoke and prevent memory leaks

// Three.js State
let scene, camera, renderer, controls, currentModel;
let mixer, clock;

let thumbRenderer, thumbScene, thumbCamera;
let thumbnailQueue = [];
let isGeneratingThumbnail = false;

function initThree() {
  scene = new THREE.Scene();
  // We want a transparent background to show the CSS gradient
  scene.background = null; 

  camera = new THREE.PerspectiveCamera(45, viewerContainer.clientWidth / viewerContainer.clientHeight, 0.1, 10000);
  camera.position.set(0, 200, 500);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(viewerContainer.clientWidth, viewerContainer.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // renderer.toneMapping = THREE.ACESFilmicToneMapping;
  viewerContainer.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;

  // Lights
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambientLight);

  const dirLight = new THREE.DirectionalLight(0xffffff, 2.0);
  dirLight.position.set(200, 500, 300);
  dirLight.castShadow = true;
  scene.add(dirLight);
  
  const backLight = new THREE.DirectionalLight(0xffffff, 0.8);
  backLight.position.set(-200, -500, -300);
  scene.add(backLight);

  // Helper grid
  const gridHelper = new THREE.GridHelper(1000, 50, 0x00f0ff, 0x444444);
  gridHelper.material.opacity = 0.2;
  gridHelper.material.transparent = true;
  gridHelper.position.y = 0;
  scene.add(gridHelper);

  clock = new THREE.Clock();
  
  initThumbnailGenerator();

  window.addEventListener('resize', onWindowResize);

  animate();
}

function onWindowResize() {
  if (!camera || !renderer) return;
  camera.aspect = viewerContainer.clientWidth / viewerContainer.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(viewerContainer.clientWidth, viewerContainer.clientHeight);
}

function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();
  if (mixer) mixer.update(delta);
  if (controls) controls.update();
  if (renderer && scene && camera) renderer.render(scene, camera);
}

// Drag & Drop Handling
function handleDragOver(e) {
  e.preventDefault();
  dropOverlay.classList.remove('hidden');
}

function handleDragLeave(e) {
  e.preventDefault();
  if (e.target === dropOverlay) {
    dropOverlay.classList.add('hidden');
  }
}

function handleDrop(e) {
  e.preventDefault();
  dropOverlay.classList.add('hidden');
  if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
    processFiles(Array.from(e.dataTransfer.files));
  }
}

document.addEventListener('dragover', handleDragOver);
document.addEventListener('dragleave', handleDragLeave);
document.addEventListener('drop', handleDrop);

browseBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
  if (e.target.files && e.target.files.length > 0) {
    processFiles(Array.from(e.target.files));
  }
});

resetCamBtn.addEventListener('click', () => {
    if(!currentModel) return;
    centerModel(currentModel);
});

exportBtn.addEventListener('click', () => {
    if(!currentModel) return;
    const exporter = new GLTFExporter();
    exporter.parse(currentModel, (gltf) => {
        const blob = new Blob([gltf], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'converted_model.glb';
        a.click();
        URL.revokeObjectURL(url);
    }, (error) => {
        console.error('Export error:', error);
        alert('Failed to export model.');
    }, { binary: true });
});

function processFiles(files) {
  // Filter only valid zip or 3D files (for simplicity we focus on .zip which is the requirement)
  const validFiles = files.filter(f => f.name.toLowerCase().endsWith('.zip') || f.name.toLowerCase().endsWith('.fbx') || f.name.toLowerCase().endsWith('.obj') || f.name.toLowerCase().endsWith('.glb'));
  if (validFiles.length === 0) return;

  validFiles.forEach(file => {
    const id = Date.now().toString() + Math.random().toString().slice(2);
    const archive = {
      id,
      name: file.name,
      file: file,
      thumbnail: null
    };
    loadedArchives.push(archive);
    thumbnailQueue.push(archive);
  });

  renderZipList();
  processThumbnailQueue();
}

function renderZipList() {
  if (loadedArchives.length === 0) {
      zipList.innerHTML = '<li class="empty-state">No files loaded yet</li>';
      return;
  }
  
  zipList.innerHTML = '';
  loadedArchives.forEach(archive => {
    const li = document.createElement('li');
    li.className = `zip-item ${archive.id === currentArchiveId ? 'active' : ''}`;
    
    let innerContent = archive.thumbnail 
        ? `<div class="zip-thumbnail-container"><img src="${archive.thumbnail}" alt="${archive.name}" /></div>`
        : `<div class="zip-thumbnail-container"><div class="zip-thumbnail-placeholder"><div class="spinner" style="width:24px;height:24px;border-width:2px;box-shadow:none;"></div><span>Generating...</span></div></div>`;
        
    innerContent += `<span class="zip-item-name" title="${archive.name}">${archive.name}</span>`;
    
    li.innerHTML = innerContent;
    li.addEventListener('click', () => selectArchive(archive));
    zipList.appendChild(li);
  });
}

function cleanupCurrentModel() {
  if (currentModel) {
    scene.remove(currentModel);
    currentModel.traverse((child) => {
      if (child.isMesh) {
        if (child.material) {
            if(Array.isArray(child.material)) {
                child.material.forEach(m => { m.dispose(); if(m.map) m.map.dispose(); });
            } else {
                child.material.dispose();
                if (child.material.map) child.material.map.dispose();
            }
        }
        if (child.geometry) child.geometry.dispose();
      }
    });
    currentModel = null;
  }
  if (mixer) {
    mixer.stopAllAction();
    mixer = null;
  }
  currentObjectURLs.forEach(url => URL.revokeObjectURL(url));
  currentObjectURLs = [];
}

async function selectArchive(archive) {
  currentArchiveId = archive.id;
  renderZipList();
  
  cleanupCurrentModel();
  
  loadingScreen.classList.remove('hidden');
  loadingText.innerText = `Extracting ${archive.name}...`;
  hud.classList.add('hidden');
  
  try {
    const isZip = archive.name.toLowerCase().endsWith('.zip');
    let filesMap = new Map(); // name -> Blob
    
    if (isZip) {
      const zFile = new JSZip();
      const zipContent = await zFile.loadAsync(archive.file);
      
      const promises = [];
      zipContent.forEach((relativePath, zipEntry) => {
        if (!zipEntry.dir) {
          promises.push(
            zipEntry.async('blob').then(blob => {
              // we store using only the filename to make texture paths easier to match later,
              // or keep relative paths. For FBX usually textures are referenced just by filename.
              const filename = relativePath.split('/').pop().toLowerCase();
              filesMap.set(filename, blob);
              filesMap.set(relativePath.toLowerCase(), blob); // keep both just in case
            })
          );
        }
      });
      await Promise.all(promises);
    } else {
      // Direct file drop
      filesMap.set(archive.name.toLowerCase(), archive.file);
    }
    
    // Find the primary 3D file (.fbx, .obj, .glb)
    let modelKeys = Array.from(filesMap.keys()).filter(k => k.endsWith('.fbx') || k.endsWith('.obj') || k.endsWith('.glb'));
    if (modelKeys.length === 0) throw new Error("No 3D model found in the archive.");
    
    // Prioritize the shortest name or first one
    const mainFileKey = modelKeys.reduce((a, b) => a.length <= b.length ? a : b);
    const mainFileBlob = filesMap.get(mainFileKey);
    const modelUrl = URL.createObjectURL(mainFileBlob);
    currentObjectURLs.push(modelUrl);
    
    loadingText.innerText = `Loading geometry...`;

    const manager = new THREE.LoadingManager();
    // Intercept image/material URLs to use Blob URLs we extract from zip
    manager.setURLModifier((url) => {
       // if url is a blob/data, pass it
       if(url.startsWith('blob:') || url.startsWith('data:')) return url;
       
       const filename = url.split('/').pop().split('\\').pop().toLowerCase();
       if (filesMap.has(filename)) {
           const blob = filesMap.get(filename);
           const blobUrl = URL.createObjectURL(blob);
           currentObjectURLs.push(blobUrl);
           return blobUrl;
       }
       return url;
    });

    const ext = mainFileKey.split('.').pop().toLowerCase();
    let loader;
    
    if (ext === 'fbx') {
       loader = new FBXLoader(manager);
       currentModel = await loader.loadAsync(modelUrl);
    } else if (ext === 'glb') {
       loader = new GLTFLoader(manager);
       const gltf = await loader.loadAsync(modelUrl);
       currentModel = gltf.scene;
       // Play animations if present
       if (gltf.animations && gltf.animations.length > 0) {
           mixer = new THREE.AnimationMixer(currentModel);
           gltf.animations.forEach(clip => mixer.clipAction(clip).play());
       }
    } else if (ext === 'obj') {
       loader = new OBJLoader(manager);
       currentModel = await loader.loadAsync(modelUrl);
    }

    if(ext === 'fbx' && currentModel.animations && currentModel.animations.length > 0) {
       mixer = new THREE.AnimationMixer(currentModel);
       currentModel.animations.forEach(clip => mixer.clipAction(clip).play());
    }

    // Centering and scaling logic
    centerModel(currentModel);
    scene.add(currentModel);

    hudTitle.innerText = archive.name;
    hud.classList.remove('hidden');

  } catch (error) {
    console.error("Error loading archive:", error);
    alert(`Failed to load ${archive.name}: ${error.message}`);
  } finally {
    loadingScreen.classList.add('hidden');
  }
}

function centerModel(model) {
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    model.position.x += (model.position.x - center.x);
    model.position.y += (model.position.y - center.y);
    model.position.z += (model.position.z - center.z);
    
    const maxDim = Math.max(size.x, size.y, size.z);
    const targetSize = 250; 
    let scale = targetSize / maxDim;
    if(!isFinite(scale) || scale === 0) scale = 1;

    model.scale.set(scale, scale, scale);

    // Update controls camera
    controls.target.set(0,0,0);
    camera.position.set(0, targetSize, targetSize*2);
    camera.lookAt(0,0,0);
}

function initThumbnailGenerator() {
    thumbScene = new THREE.Scene();
    thumbScene.background = new THREE.Color(0x1a1a24);
    thumbCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
    thumbRenderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    thumbRenderer.setSize(256, 256);
    thumbRenderer.outputColorSpace = THREE.SRGBColorSpace;
    thumbScene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const dirLight = new THREE.DirectionalLight(0xffffff, 2.0);
    dirLight.position.set(200, 500, 300);
    thumbScene.add(dirLight);
}

async function processThumbnailQueue() {
    if (isGeneratingThumbnail || thumbnailQueue.length === 0) return;
    isGeneratingThumbnail = true;
    
    const archive = thumbnailQueue.shift();
    try {
        const isZip = archive.name.toLowerCase().endsWith('.zip');
        let filesMap = new Map();
        let tempObjectURLs = [];
        
        if (isZip) {
            const zFile = new JSZip();
            const zipContent = await zFile.loadAsync(archive.file);
            const promises = [];
            zipContent.forEach((relativePath, zipEntry) => {
                const lower = relativePath.toLowerCase();
                if (!zipEntry.dir && (lower.endsWith('.fbx') || lower.endsWith('.obj') || lower.endsWith('.glb') || lower.match(/\.(png|jpg|jpeg|tga|dds)$/i))) {
                    promises.push(
                        zipEntry.async('blob').then(blob => {
                            filesMap.set(relativePath.split('/').pop().toLowerCase(), blob);
                        })
                    );
                }
            });
            await Promise.all(promises);
        } else {
            filesMap.set(archive.name.toLowerCase(), archive.file);
        }
        
        let modelKeys = Array.from(filesMap.keys()).filter(k => k.endsWith('.fbx') || k.endsWith('.obj') || k.endsWith('.glb'));
        if (modelKeys.length > 0) {
            const mainFileKey = modelKeys.reduce((a, b) => a.length <= b.length ? a : b);
            const modelUrl = URL.createObjectURL(filesMap.get(mainFileKey));
            tempObjectURLs.push(modelUrl);
            
            const manager = new THREE.LoadingManager();
            manager.setURLModifier((url) => {
                if(url.startsWith('blob:') || url.startsWith('data:')) return url;
                const filename = url.split('/').pop().split('\\').pop().toLowerCase();
                if (filesMap.has(filename)) {
                    const blobUrl = URL.createObjectURL(filesMap.get(filename));
                    tempObjectURLs.push(blobUrl);
                    return blobUrl;
                }
                return url;
            });
            
            const ext = mainFileKey.split('.').pop().toLowerCase();
            let loader, model;
            if (ext === 'fbx') { loader = new FBXLoader(manager); model = await loader.loadAsync(modelUrl); }
            else if (ext === 'glb') { loader = new GLTFLoader(manager); model = (await loader.loadAsync(modelUrl)).scene; }
            else if (ext === 'obj') { loader = new OBJLoader(manager); model = await loader.loadAsync(modelUrl); }
            
            if (model) {
                const box = new THREE.Box3().setFromObject(model);
                const size = box.getSize(new THREE.Vector3());
                const center = box.getCenter(new THREE.Vector3());
                model.position.sub(center);
                const maxDim = Math.max(size.x, size.y, size.z);
                const scale = maxDim > 0 ? 150 / maxDim : 1;
                model.scale.set(scale, scale, scale);
                
                thumbScene.add(model);
                thumbCamera.position.set(200, 200, 250);
                thumbCamera.lookAt(0,0,0);
                
                thumbRenderer.compile(thumbScene, thumbCamera);
                thumbRenderer.render(thumbScene, thumbCamera);
                await new Promise(r => setTimeout(r, 150));
                
                thumbRenderer.render(thumbScene, thumbCamera);
                
                archive.thumbnail = thumbRenderer.domElement.toDataURL('image/jpeg', 0.8);
                
                thumbScene.remove(model);
                model.traverse((child) => {
                    if (child.isMesh) {
                        if (child.geometry) child.geometry.dispose();
                        if (child.material) {
                            (Array.isArray(child.material) ? child.material : [child.material]).forEach(m => {
                                m.dispose(); if(m.map) m.map.dispose();
                            });
                        }
                    }
                });
            }
        }
        tempObjectURLs.forEach(url => URL.revokeObjectURL(url));
    } catch(err) {
        console.error("Thumbnail error:", err);
    }
    
    renderZipList();
    isGeneratingThumbnail = false;
    processThumbnailQueue();
}

initThree();
