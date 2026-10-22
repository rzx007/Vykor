import {readFileSync,writeFileSync} from "node:fs";
import {resolve,dirname} from "node:path";
import {pathToFileURL,fileURLToPath} from "node:url";
const here=dirname(fileURLToPath(import.meta.url)),repo=resolve(here,"../../..");
const {GLTFLoader}=await import(pathToFileURL(resolve(repo,"node_modules/.pnpm/three@0.184.0/node_modules/three/examples/jsm/loaders/GLTFLoader.js")));
const {AnimationMixer,Box3}=await import(pathToFileURL(resolve(repo,"node_modules/.pnpm/three@0.184.0/node_modules/three/build/three.module.js")));
const bytes=readFileSync(resolve(here,"../brand/vykor-optical-mark.glb"));
const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),"");
const clip=gltf.animations.find(a=>a.name==="scrollani");
if(!clip||Math.abs(clip.duration-4)>.001)throw Error("Missing 4s scrollani clip");
const meshes=[];gltf.scene.traverse(o=>{if(o.isMesh){meshes.push(o.name);for(const n of o.geometry.attributes.position.array)if(!Number.isFinite(n))throw Error("Nonfinite geometry")}});
const mixer=new AnimationMixer(gltf.scene);const action=mixer.clipAction(clip);action.clampWhenFinished=true;action.play();
mixer.setTime(0);gltf.scene.updateMatrixWorld(true);const initial=new Box3().setFromObject(gltf.scene);
mixer.setTime(3.9999);gltf.scene.updateMatrixWorld(true);const final=new Box3().setFromObject(gltf.scene);
const initialWidth=initial.max.x-initial.min.x,finalWidth=final.max.x-final.min.x;
if(initialWidth/finalWidth<2)throw Error("Close-up and assembled animation states are too similar");
const result={passed:true,loader:"Three.js GLTFLoader r184",clip:clip.name,duration:clip.duration,meshes,initialWidth,finalWidth,scaleRatio:initialWidth/finalWidth};
writeFileSync(resolve(here,"../brand/model-verification.json"),JSON.stringify(result,null,2));console.log(JSON.stringify(result));

