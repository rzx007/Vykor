import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
const status=document.querySelector("#status");
const slider=document.querySelector("#progress");
const canvas=document.querySelector("canvas");
const binary=Uint8Array.from(atob(document.querySelector("#model-data").textContent.trim()),c=>c.charCodeAt(0));
const blob=new Blob([binary],{type:"model/gltf-binary"});
const url=URL.createObjectURL(blob);
const link=document.querySelector("#download");
link.href=url;
link.download="vykor-optical-mark.glb";
try {
 const renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:true});
 renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));
 renderer.toneMapping=THREE.ACESFilmicToneMapping;
 renderer.toneMappingExposure=1.25;
 const scene=new THREE.Scene();
 const camera=new THREE.PerspectiveCamera(36,1,.05,100);
 camera.position.set(0,0,9);
 const pmrem=new THREE.PMREMGenerator(renderer);
 const room=new RoomEnvironment();
 scene.environment=pmrem.fromScene(room,.04).texture;
 room.dispose();
 const gltf=await new GLTFLoader().parseAsync(binary.buffer,"");
 scene.add(gltf.scene);
 gltf.scene.traverse(o=>{
   if(!o.isMesh)return;
   for(const mat of Array.isArray(o.material)?o.material:[o.material]){
     mat.envMapIntensity=1.7;
     if(mat.transmission>.5){mat.thickness=.26;mat.roughness=.06;mat.ior=1.48;mat.dispersion=.7;}
   }
 });
 const mixer=new THREE.AnimationMixer(gltf.scene);
 const clip=gltf.animations.find(c=>c.name==="scrollani")||gltf.animations[0];
 const action=mixer.clipAction(clip);action.setLoop(THREE.LoopOnce,1);action.clampWhenFinished=true;action.play();
 function render(){
   const box=canvas.getBoundingClientRect();
   renderer.setSize(box.width,box.height,false);
   camera.aspect=box.width/box.height;camera.updateProjectionMatrix();
   mixer.setTime(Math.min(clip.duration-0.00001,Number(slider.value)*clip.duration));
   gltf.scene.traverse(o=>{if(o.name.startsWith("Lime_Inlay"))o.visible=document.querySelector("#inlay").checked;});
   renderer.render(scene,camera);
   status.textContent=Math.round(Number(slider.value)*100)+"% · "+clip.duration.toFixed(1)+" 秒动画";
 }
 slider.addEventListener("input",render);
 document.querySelector("#inlay").addEventListener("change",render);
 document.querySelector("#start").onclick=()=>{slider.value="0";render()};
 document.querySelector("#end").onclick=()=>{slider.value="1";render()};
 new ResizeObserver(render).observe(canvas);
 render();
 window.__VYKOR_MODEL_VERIFIED__={clip:clip.name,duration:clip.duration,meshes:[]};
 gltf.scene.traverse(o=>{if(o.isMesh)window.__VYKOR_MODEL_VERIFIED__.meshes.push(o.name)});
}catch(error){
 canvas.style.display="none";
 document.querySelector("#fallback").hidden=false;
 status.textContent="当前浏览器未启用 WebGL，可使用静态图或下载模型。";
 console.warn(error);
}

