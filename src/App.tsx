import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Upload, Download, RefreshCw, Image as ImageIcon, CheckCircle2, AlertCircle, Crop as CropIcon, X, Maximize2, Minimize2, RotateCw, MousePointer2, ScanLine, Camera } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import Cropper, { Area } from 'react-easy-crop';
import * as pdfjsLib from 'pdfjs-dist';
// @ts-ignore
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';

// Set up PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

interface Point {
  x: number;
  y: number;
}

interface ImageState {
  file: File | null;
  preview: string | null;
  processedPreview: string | null;
  croppedAreaPixels: Area | null;
  rotation: number;
  perspectivePoints: Point[] | null;
}

type Layout = 'landscape' | 'portrait';
type CardOrientation = 'landscape' | 'portrait';
type CropMode = 'standard' | 'perspective';

const INDIAN_ID_RATIO = 85.6 / 53.98; // ~1.586

export default function App() {
  const [front, setFront] = useState<ImageState>({ file: null, preview: null, processedPreview: null, croppedAreaPixels: null, rotation: 0, perspectivePoints: null });
  const [back, setBack] = useState<ImageState>({ file: null, preview: null, processedPreview: null, croppedAreaPixels: null, rotation: 0, perspectivePoints: null });
  const [layout, setLayout] = useState<Layout>('landscape');
  const [cardOrientation, setCardOrientation] = useState<CardOrientation>('landscape');
  const [mergedImage, setMergedImage] = useState<string | null>(null);
  const [isMerging, setIsMerging] = useState(false);
  
  // Cropper State
  const [activeCropSide, setActiveCropSide] = useState<'front' | 'back' | null>(null);
  const [cropMode, setCropMode] = useState<CropMode>('standard');
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [tempCroppedAreaPixels, setTempCroppedAreaPixels] = useState<Area | null>(null);
  const [perspectivePoints, setPerspectivePoints] = useState<Point[]>([
    { x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 90 }, { x: 10, y: 90 }
  ]);

  // Camera State
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [cameraSide, setCameraSide] = useState<'front' | 'back' | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const perspectiveContainerRef = useRef<HTMLDivElement>(null);

  const handleFileChange = (side: 'front' | 'back') => async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.type === 'application/pdf') {
        try {
          const reader = new FileReader();
          reader.onload = async () => {
            const typedarray = new Uint8Array(reader.result as ArrayBuffer);
            const pdf = await pdfjsLib.getDocument(typedarray).promise;
            const page = await pdf.getPage(1); // Get first page
            const viewport = page.getViewport({ scale: 2.0 }); // Higher scale for better quality
            
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d')!;
            canvas.height = viewport.height;
            canvas.width = viewport.width;

            await page.render({ canvasContext: context, viewport: viewport, canvas: canvas }).promise;
            const preview = canvas.toDataURL('image/jpeg', 0.9);
            
            const result = { file, preview, processedPreview: null, croppedAreaPixels: null, rotation: 0, perspectivePoints: null };
            if (side === 'front') setFront(result);
            else setBack(result);
            setMergedImage(null);
            setActiveCropSide(side);
            setRotation(0);
            setCropMode('perspective'); // Default to perspective for PDF extracts
          };
          reader.readAsArrayBuffer(file);
        } catch (err) {
          console.error("Error processing PDF:", err);
          alert("Failed to process PDF. Please try an image instead.");
        }
        return;
      }

      const reader = new FileReader();
      reader.onloadend = () => {
        const result = { file, preview: reader.result as string, processedPreview: null, croppedAreaPixels: null, rotation: 0, perspectivePoints: null };
        if (side === 'front') setFront(result);
        else setBack(result);
        setMergedImage(null);
        setActiveCropSide(side);
        setRotation(0);
        setCropMode('standard');
      };
      reader.readAsDataURL(file);
    }
  };

  const onCropComplete = useCallback((_croppedArea: Area, croppedAreaPixels: Area) => {
    setTempCroppedAreaPixels(croppedAreaPixels);
  }, []);

  const saveCrop = async () => {
    const side = activeCropSide;
    if (!side) return;

    const updateState = (prev: ImageState) => ({
      ...prev,
      croppedAreaPixels: cropMode === 'standard' ? tempCroppedAreaPixels : null,
      rotation: rotation,
      perspectivePoints: cropMode === 'perspective' ? perspectivePoints : null
    });

    // We need to calculate the processed preview immediately to show it in the UI
    const currentState = side === 'front' ? front : back;
    const nextState: ImageState = {
      ...currentState,
      croppedAreaPixels: cropMode === 'standard' ? tempCroppedAreaPixels : null,
      rotation: rotation,
      perspectivePoints: cropMode === 'perspective' ? perspectivePoints : null
    };

    try {
      const processedCanvas = await getProcessedImg(nextState);
      nextState.processedPreview = processedCanvas.toDataURL('image/jpeg', 0.8);
      
      if (side === 'front') setFront(nextState);
      else setBack(nextState);
    } catch (error) {
      console.error("Error processing preview:", error);
      // Fallback to just updating the metadata
      if (side === 'front') setFront(updateState);
      else if (side === 'back') setBack(updateState);
    }
    
    setActiveCropSide(null);
    setMergedImage(null);
  };

  // Perspective Transform Logic
  const applyPerspective = (ctx: CanvasRenderingContext2D, image: HTMLImageElement, points: Point[], targetWidth: number, targetHeight: number) => {
    const canvas = ctx.canvas;
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    // Helper to solve linear system for homography
    const getTransform = (src: Point[], dst: Point[]) => {
      const p = [];
      for (let i = 0; i < 4; i++) {
        p.push([src[i].x, src[i].y, 1, 0, 0, 0, -dst[i].x * src[i].x, -dst[i].x * src[i].y]);
        p.push([0, 0, 0, src[i].x, src[i].y, 1, -dst[i].y * src[i].x, -dst[i].y * src[i].y]);
      }
      const b = [dst[0].x, dst[0].y, dst[1].x, dst[1].y, dst[2].x, dst[2].y, dst[3].x, dst[3].y];
      
      // Simple Gaussian elimination for 8x8
      const solve = (A: number[][], b: number[]) => {
        const n = A.length;
        for (let i = 0; i < n; i++) {
          let max = i;
          for (let j = i + 1; j < n; j++) if (Math.abs(A[j][i]) > Math.abs(A[max][i])) max = j;
          [A[i], A[max]] = [A[max], A[i]];
          [b[i], b[max]] = [b[max], b[i]];
          for (let j = i + 1; j < n; j++) {
            const f = A[j][i] / A[i][i];
            b[j] -= f * b[i];
            for (let k = i; k < n; k++) A[j][k] -= f * A[i][k];
          }
        }
        const x = new Array(n).fill(0);
        for (let i = n - 1; i >= 0; i--) {
          let s = 0;
          for (let j = i + 1; j < n; j++) s += A[i][j] * x[j];
          x[i] = (b[i] - s) / A[i][i];
        }
        return x;
      };
      return solve(p, b);
    };

    const srcPoints = points.map(p => ({ x: p.x * image.width / 100, y: p.y * image.height / 100 }));
    const dstPoints = [
      { x: 0, y: 0 }, { x: targetWidth, y: 0 }, { x: targetWidth, y: targetHeight }, { x: 0, y: targetHeight }
    ];

    const h = getTransform(dstPoints, srcPoints); // Inverse transform for pixel mapping
    const imgData = ctx.createImageData(targetWidth, targetHeight);
    
    // Draw image to a temp canvas to get pixel data
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = image.width;
    tempCanvas.height = image.height;
    const tempCtx = tempCanvas.getContext('2d')!;
    tempCtx.drawImage(image, 0, 0);
    const srcData = tempCtx.getImageData(0, 0, image.width, image.height);

    for (let y = 0; y < targetHeight; y++) {
      for (let x = 0; x < targetWidth; x++) {
        const z = h[6] * x + h[7] * y + 1;
        const sx = Math.floor((h[0] * x + h[1] * y + h[2]) / z);
        const sy = Math.floor((h[3] * x + h[4] * y + h[5]) / z);

        if (sx >= 0 && sx < image.width && sy >= 0 && sy < image.height) {
          const dstIdx = (y * targetWidth + x) * 4;
          const srcIdx = (sy * image.width + sx) * 4;
          imgData.data[dstIdx] = srcData.data[srcIdx];
          imgData.data[dstIdx + 1] = srcData.data[srcIdx + 1];
          imgData.data[dstIdx + 2] = srcData.data[srcIdx + 2];
          imgData.data[dstIdx + 3] = srcData.data[srcIdx + 3];
        }
      }
    }
    ctx.putImageData(imgData, 0, 0);
  };

  const getProcessedImg = async (state: ImageState): Promise<HTMLCanvasElement> => {
    const image = new Image();
    image.src = state.preview!;
    await new Promise(resolve => image.onload = resolve);

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;

    if (state.perspectivePoints) {
      const targetWidth = 1000;
      const ratio = cardOrientation === 'landscape' ? INDIAN_ID_RATIO : 1 / INDIAN_ID_RATIO;
      const targetHeight = targetWidth / ratio;
      applyPerspective(ctx, image, state.perspectivePoints, targetWidth, targetHeight);
      return canvas;
    }

    // Standard crop/rotate
    const rotationRad = (state.rotation * Math.PI) / 180;
    const rotateSize = (w: number, h: number) => ({
      width: Math.abs(Math.cos(rotationRad) * w) + Math.abs(Math.sin(rotationRad) * h),
      height: Math.abs(Math.sin(rotationRad) * w) + Math.abs(Math.cos(rotationRad) * h),
    });

    const { width: rotW, height: rotH } = rotateSize(image.width, image.height);
    canvas.width = rotW;
    canvas.height = rotH;
    ctx.translate(rotW / 2, rotH / 2);
    ctx.rotate(rotationRad);
    ctx.drawImage(image, -image.width / 2, -image.height / 2);

    if (state.croppedAreaPixels) {
      const cropCanvas = document.createElement('canvas');
      cropCanvas.width = state.croppedAreaPixels.width;
      cropCanvas.height = state.croppedAreaPixels.height;
      const cropCtx = cropCanvas.getContext('2d')!;
      cropCtx.drawImage(
        canvas,
        state.croppedAreaPixels.x,
        state.croppedAreaPixels.y,
        state.croppedAreaPixels.width,
        state.croppedAreaPixels.height,
        0,
        0,
        state.croppedAreaPixels.width,
        state.croppedAreaPixels.height
      );
      return cropCanvas;
    }

    return canvas;
  };

  const mergeImages = useCallback(async () => {
    if (!front.preview || !back.preview) return;
    setIsMerging(true);
    try {
      const [canvasFront, canvasBack] = await Promise.all([
        getProcessedImg(front),
        getProcessedImg(back)
      ]);

      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d')!;

      if (layout === 'landscape') {
        const targetHeight = Math.max(canvasFront.height, canvasBack.height);
        const widthFront = canvasFront.width * (targetHeight / canvasFront.height);
        const widthBack = canvasBack.width * (targetHeight / canvasBack.height);
        canvas.width = widthFront + widthBack;
        canvas.height = targetHeight;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(canvasFront, 0, 0, widthFront, targetHeight);
        ctx.drawImage(canvasBack, widthFront, 0, widthBack, targetHeight);
      } else {
        const targetWidth = Math.max(canvasFront.width, canvasBack.width);
        const heightFront = canvasFront.height * (targetWidth / canvasFront.width);
        const heightBack = canvasBack.height * (targetWidth / canvasBack.width);
        canvas.width = targetWidth;
        canvas.height = heightFront + heightBack;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(canvasFront, 0, 0, targetWidth, heightFront);
        ctx.drawImage(canvasBack, 0, heightFront, targetWidth, heightBack);
      }
      setMergedImage(canvas.toDataURL('image/jpeg', 0.9));
    } catch (error) {
      console.error('Error merging:', error);
      alert('Merge failed.');
    } finally {
      setIsMerging(false);
    }
  }, [front, back, layout]);

  const downloadImage = () => {
    if (!mergedImage) return;
    const link = document.createElement('a');
    link.download = `id-card-merged-${layout}.jpg`;
    link.href = mergedImage;
    link.click();
  };

  const reset = () => {
    setFront({ file: null, preview: null, processedPreview: null, croppedAreaPixels: null, rotation: 0, perspectivePoints: null });
    setBack({ file: null, preview: null, processedPreview: null, croppedAreaPixels: null, rotation: 0, perspectivePoints: null });
    setMergedImage(null);
  };

  const startCamera = async (side: 'front' | 'back') => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert("Your browser does not support camera access. Please try a different browser or upload images manually.");
      return;
    }

    setCameraSide(side);
    setIsCameraOpen(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } } 
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
    } catch (err: any) {
      console.error("Error accessing camera:", err);
      let message = "Could not access camera.";
      
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        message = "Camera permission was denied. Please click the camera icon in your browser address bar to allow access and try again.";
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        message = "No camera found on this device.";
      } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
        message = "Camera is already in use by another application.";
      } else {
        message = "Camera permission was dismissed or blocked. Please ensure you allow camera access in your browser settings.";
      }
      
      alert(message);
      stopCamera();
    }
  };

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    setIsCameraOpen(false);
    setCameraSide(null);
  };

  const capturePhoto = () => {
    if (videoRef.current && cameraSide) {
      const video = videoRef.current;
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(video, 0, 0);
        const preview = canvas.toDataURL('image/jpeg');
        const result = { file: null, preview, processedPreview: null, croppedAreaPixels: null, rotation: 0, perspectivePoints: null };
        if (cameraSide === 'front') setFront(result);
        else setBack(result);
        setMergedImage(null);
        setActiveCropSide(cameraSide);
        setRotation(0);
        setCropMode('perspective'); // Default to perspective for camera shots
      }
      stopCamera();
    }
  };

  const currentCropImage = activeCropSide === 'front' ? front.preview : back.preview;
  const cropRatio = cardOrientation === 'landscape' ? INDIAN_ID_RATIO : 1 / INDIAN_ID_RATIO;

  const handlePointDrag = (index: number, e: React.MouseEvent | React.TouchEvent) => {
    const container = perspectiveContainerRef.current;
    if (!container) return;

    const move = (moveEvent: MouseEvent | TouchEvent) => {
      const rect = container.getBoundingClientRect();
      const clientX = 'touches' in moveEvent ? moveEvent.touches[0].clientX : moveEvent.clientX;
      const clientY = 'touches' in moveEvent ? moveEvent.touches[0].clientY : moveEvent.clientY;
      
      const x = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
      const y = Math.max(0, Math.min(100, ((clientY - rect.top) / rect.height) * 100));
      
      setPerspectivePoints(prev => {
        const next = [...prev];
        next[index] = { x, y };
        return next;
      });
    };

    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      window.removeEventListener('touchmove', move);
      window.removeEventListener('touchend', up);
    };

    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    window.addEventListener('touchmove', move);
    window.addEventListener('touchend', up);
  };

  return (
    <div className="min-h-screen bg-[#f8f9fa] text-[#1a1a1a] font-sans p-4 md:p-8">
      <div className="max-w-5xl mx-auto">
        <header className="mb-10 text-center">
          <motion.h1 
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-4xl font-light tracking-tight mb-2"
          >
            Indian ID <span className="font-semibold">Merger Pro</span>
          </motion.h1>
          <motion.p 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.2 }}
            className="text-[#9e9e9e] text-sm uppercase tracking-widest flex items-center justify-center gap-2"
          >
            Standard CR80 Size (85.6 x 53.98 mm)
          </motion.p>
        </header>

        {/* Configuration Controls */}
        <div className="flex flex-col md:flex-row justify-center gap-4 mb-8">
          {/* Card Orientation */}
          <div className="bg-white p-1 rounded-2xl shadow-sm border border-black/5 flex flex-col items-center">
            <span className="text-[9px] font-bold text-black/30 uppercase tracking-widest mb-1">Card Shape</span>
            <div className="flex gap-1">
              <button
                onClick={() => { setCardOrientation('landscape'); setMergedImage(null); }}
                className={`px-4 py-2 rounded-xl text-[10px] font-bold uppercase tracking-widest transition-all ${cardOrientation === 'landscape' ? 'bg-[#1a1a1a] text-white shadow-md' : 'text-black/40 hover:text-black/60 hover:bg-black/5'}`}
              >
                Landscape Card
              </button>
              <button
                onClick={() => { setCardOrientation('portrait'); setMergedImage(null); }}
                className={`px-4 py-2 rounded-xl text-[10px] font-bold uppercase tracking-widest transition-all ${cardOrientation === 'portrait' ? 'bg-[#1a1a1a] text-white shadow-md' : 'text-black/40 hover:text-black/60 hover:bg-black/5'}`}
              >
                Portrait Card
              </button>
            </div>
          </div>

          {/* Merge Layout */}
          <div className="bg-white p-1 rounded-2xl shadow-sm border border-black/5 flex flex-col items-center">
            <span className="text-[9px] font-bold text-black/30 uppercase tracking-widest mb-1">Merge Layout</span>
            <div className="flex gap-1">
              <button
                onClick={() => { setLayout('landscape'); setMergedImage(null); }}
                className={`px-4 py-2 rounded-xl text-[10px] font-bold uppercase tracking-widest transition-all ${layout === 'landscape' ? 'bg-[#1a1a1a] text-white shadow-md' : 'text-black/40 hover:text-black/60 hover:bg-black/5'}`}
              >
                Side-by-Side
              </button>
              <button
                onClick={() => { setLayout('portrait'); setMergedImage(null); }}
                className={`px-4 py-2 rounded-xl text-[10px] font-bold uppercase tracking-widest transition-all ${layout === 'portrait' ? 'bg-[#1a1a1a] text-white shadow-md' : 'text-black/40 hover:text-black/60 hover:bg-black/5'}`}
              >
                Top-Bottom
              </button>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-10">
          {/* Front Side */}
          <div className="bg-white rounded-[2rem] p-6 shadow-sm border border-black/5 relative overflow-hidden">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xs font-bold uppercase tracking-widest text-[#9e9e9e]">Front Side</h2>
              <div className="flex gap-2">
                {front.preview && (
                  <button 
                    onClick={() => { setActiveCropSide('front'); setRotation(front.rotation); setCropMode(front.perspectivePoints ? 'perspective' : 'standard'); if(front.perspectivePoints) setPerspectivePoints(front.perspectivePoints); }}
                    className="p-2 rounded-lg hover:bg-black/5 text-black/40 transition-colors"
                    title="Edit Image"
                  >
                    <CropIcon className="w-4 h-4" />
                  </button>
                )}
                {front.preview && <CheckCircle2 className="w-5 h-5 text-emerald-500" />}
              </div>
            </div>
            <div className={`relative flex flex-col items-center justify-center w-full border-2 border-dashed rounded-3xl transition-all overflow-hidden ${front.preview ? 'border-emerald-100 bg-emerald-50/10' : 'border-black/10 bg-black/[0.01]'} ${cardOrientation === 'landscape' ? 'aspect-[1.586/1]' : 'aspect-[1/1.586]'}`}>
              {front.preview ? (
                <div className="relative w-full h-full group">
                  <img src={front.processedPreview || front.preview} alt="Front" className="w-full h-full object-contain" style={{ transform: front.processedPreview ? 'none' : `rotate(${front.rotation}deg)` }} />
                  <label className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center cursor-pointer">
                    <span className="text-white text-xs font-medium bg-black/50 px-3 py-1.5 rounded-full">Change Image</span>
                    <input type="file" className="hidden" accept="image/*,application/pdf" onChange={handleFileChange('front')} />
                  </label>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-6 p-4">
                  <div className="flex flex-col sm:flex-row gap-4">
                    <button 
                      type="button"
                      onClick={() => startCamera('front')}
                      className="flex flex-col items-center justify-center gap-2 px-6 py-4 rounded-2xl bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-700 transition-all border border-emerald-500/20 group"
                    >
                      <Camera className="w-6 h-6 group-hover:scale-110 transition-transform" />
                      <span className="text-[10px] font-bold uppercase tracking-widest">Scan Card</span>
                    </button>
                    
                    <label className="flex flex-col items-center justify-center gap-2 px-6 py-4 rounded-2xl bg-black/5 hover:bg-black/10 text-black/60 transition-all border border-black/10 cursor-pointer group">
                      <Upload className="w-6 h-6 group-hover:scale-110 transition-transform" />
                      <span className="text-[10px] font-bold uppercase tracking-widest text-center">Upload File<br/><span className="text-[8px] opacity-60">(IMG/PDF)</span></span>
                      <input type="file" className="hidden" accept="image/*,application/pdf" onChange={handleFileChange('front')} />
                    </label>
                  </div>
                  <p className="text-[9px] text-black/30 font-bold uppercase tracking-widest text-center">Select an option to add front side (IMG/PDF)</p>
                </div>
              )}
            </div>
          </div>

          {/* Back Side */}
          <div className="bg-white rounded-[2rem] p-6 shadow-sm border border-black/5 relative overflow-hidden">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xs font-bold uppercase tracking-widest text-[#9e9e9e]">Back Side</h2>
              <div className="flex gap-2">
                {back.preview && (
                  <button 
                    onClick={() => { setActiveCropSide('back'); setRotation(back.rotation); setCropMode(back.perspectivePoints ? 'perspective' : 'standard'); if(back.perspectivePoints) setPerspectivePoints(back.perspectivePoints); }}
                    className="p-2 rounded-lg hover:bg-black/5 text-black/40 transition-colors"
                    title="Edit Image"
                  >
                    <CropIcon className="w-4 h-4" />
                  </button>
                )}
                {back.preview && <CheckCircle2 className="w-5 h-5 text-emerald-500" />}
              </div>
            </div>
            <div className={`relative flex flex-col items-center justify-center w-full border-2 border-dashed rounded-3xl transition-all overflow-hidden ${back.preview ? 'border-emerald-100 bg-emerald-50/10' : 'border-black/10 bg-black/[0.01]'} ${cardOrientation === 'landscape' ? 'aspect-[1.586/1]' : 'aspect-[1/1.586]'}`}>
              {back.preview ? (
                <div className="relative w-full h-full group">
                  <img src={back.processedPreview || back.preview} alt="Back" className="w-full h-full object-contain" style={{ transform: back.processedPreview ? 'none' : `rotate(${back.rotation}deg)` }} />
                  <label className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center cursor-pointer">
                    <span className="text-white text-xs font-medium bg-black/50 px-3 py-1.5 rounded-full">Change Image</span>
                    <input type="file" className="hidden" accept="image/*,application/pdf" onChange={handleFileChange('back')} />
                  </label>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-6 p-4">
                  <div className="flex flex-col sm:flex-row gap-4">
                    <button 
                      type="button"
                      onClick={() => startCamera('back')}
                      className="flex flex-col items-center justify-center gap-2 px-6 py-4 rounded-2xl bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-700 transition-all border border-emerald-500/20 group"
                    >
                      <Camera className="w-6 h-6 group-hover:scale-110 transition-transform" />
                      <span className="text-[10px] font-bold uppercase tracking-widest">Scan Card</span>
                    </button>
                    
                    <label className="flex flex-col items-center justify-center gap-2 px-6 py-4 rounded-2xl bg-black/5 hover:bg-black/10 text-black/60 transition-all border border-black/10 cursor-pointer group">
                      <Upload className="w-6 h-6 group-hover:scale-110 transition-transform" />
                      <span className="text-[10px] font-bold uppercase tracking-widest text-center">Upload File<br/><span className="text-[8px] opacity-60">(IMG/PDF)</span></span>
                      <input type="file" className="hidden" accept="image/*,application/pdf" onChange={handleFileChange('back')} />
                    </label>
                  </div>
                  <p className="text-[9px] text-black/30 font-bold uppercase tracking-widest text-center">Select an option to add back side (IMG/PDF)</p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-col items-center gap-4 mb-16">
          <div className="flex gap-4">
            <button
              onClick={mergeImages}
              disabled={!front.preview || !back.preview || isMerging}
              className={`px-10 py-4 rounded-2xl font-bold uppercase tracking-widest text-xs flex items-center gap-3 transition-all ${
                !front.preview || !back.preview || isMerging
                  ? 'bg-black/5 text-black/20 cursor-not-allowed'
                  : 'bg-[#1a1a1a] text-white hover:bg-black/80 shadow-2xl shadow-black/20 active:scale-95'
              }`}
            >
              {isMerging ? (
                <RefreshCw className="w-4 h-4 animate-spin" />
              ) : (
                <ImageIcon className="w-4 h-4" />
              )}
              {isMerging ? 'Processing...' : 'Merge & Standardize'}
            </button>

            {(front.preview || back.preview) && (
              <button
                onClick={reset}
                className="p-4 rounded-2xl border border-black/10 text-black/40 hover:text-black/60 hover:bg-black/5 transition-all active:scale-95"
                title="Reset All"
              >
                <RefreshCw className="w-5 h-5" />
              </button>
            )}
          </div>

          {!front.preview || !back.preview ? (
            <p className="text-[10px] font-bold uppercase tracking-widest text-[#9e9e9e] flex items-center gap-2">
              <AlertCircle className="w-3 h-3" />
              Upload both sides to enable merging
            </p>
          ) : null}
        </div>

        {/* Result Preview */}
        <AnimatePresence>
          {mergedImage && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white rounded-[3rem] p-10 shadow-2xl border border-black/5 mb-16"
            >
              <div className="flex flex-col md:flex-row items-center justify-between gap-6 mb-8">
                <div>
                  <h2 className="text-2xl font-semibold mb-1">Final Document</h2>
                  <p className="text-xs text-[#9e9e9e] font-medium uppercase tracking-widest">Ready for printing or digital submission</p>
                </div>
                <button
                  onClick={downloadImage}
                  className="w-full md:w-auto flex items-center justify-center gap-3 px-8 py-4 bg-emerald-500 text-white rounded-2xl font-bold uppercase tracking-widest text-xs hover:bg-emerald-600 transition-all active:scale-95 shadow-xl shadow-emerald-500/20"
                >
                  <Download className="w-4 h-4" />
                  Download Final JPG
                </button>
              </div>
              <div className="bg-[#f0f0f0] rounded-3xl p-6 border border-black/[0.03] shadow-inner">
                <img src={mergedImage} alt="Merged ID Card" className="w-full h-auto rounded-xl shadow-lg" />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Crop Modal */}
        <AnimatePresence>
          {activeCropSide && currentCropImage && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/90 backdrop-blur-sm"
            >
              <motion.div
                initial={{ scale: 0.9, y: 20 }}
                animate={{ scale: 1, y: 0 }}
                className="bg-white w-full max-w-4xl rounded-[2.5rem] overflow-hidden flex flex-col h-[90vh]"
              >
                <div className="p-6 border-b border-black/5 flex items-center justify-between">
                  <div>
                    <h3 className="text-lg font-bold">Edit {activeCropSide === 'front' ? 'Front' : 'Back'} Side</h3>
                    <p className="text-xs text-black/40 font-medium">Rotate, crop, or fix perspective</p>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="bg-black/5 p-1 rounded-xl flex gap-1">
                      <button 
                        onClick={() => setCropMode('standard')}
                        className={`px-4 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-widest transition-all ${cropMode === 'standard' ? 'bg-white shadow-sm text-black' : 'text-black/40 hover:text-black/60'}`}
                      >
                        Standard
                      </button>
                      <button 
                        onClick={() => setCropMode('perspective')}
                        className={`px-4 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-widest transition-all ${cropMode === 'perspective' ? 'bg-white shadow-sm text-black' : 'text-black/40 hover:text-black/60'}`}
                      >
                        Perspective
                      </button>
                    </div>
                    <button onClick={() => setActiveCropSide(null)} className="p-2 rounded-full hover:bg-black/5 transition-colors">
                      <X className="w-6 h-6" />
                    </button>
                  </div>
                </div>
                
                <div className="relative flex-1 bg-[#121212] overflow-hidden">
                  {cropMode === 'standard' ? (
                    <Cropper
                      image={currentCropImage}
                      crop={crop}
                      zoom={zoom}
                      rotation={rotation}
                      aspect={cropRatio}
                      onCropChange={setCrop}
                      onCropComplete={onCropComplete}
                      onZoomChange={setZoom}
                      onRotationChange={setRotation}
                    />
                  ) : (
                    <div ref={perspectiveContainerRef} className="w-full h-full relative flex items-center justify-center p-8">
                      <div className="relative max-w-full max-h-full">
                        <img src={currentCropImage} alt="Perspective Source" className="max-w-full max-h-[70vh] block select-none" style={{ transform: `rotate(${rotation}deg)` }} />
                        <svg className="absolute inset-0 w-full h-full pointer-events-none overflow-visible">
                          <polygon 
                            points={perspectivePoints.map(p => `${p.x}%,${p.y}%`).join(' ')} 
                            className="fill-emerald-500/20 stroke-emerald-500 stroke-2"
                          />
                          {perspectivePoints.map((p, i) => (
                            <circle 
                              key={i} 
                              cx={`${p.x}%`} 
                              cy={`${p.y}%`} 
                              r="12" 
                              className="fill-white stroke-emerald-500 stroke-2 pointer-events-auto cursor-move shadow-xl"
                              onMouseDown={(e) => handlePointDrag(i, e)}
                              onTouchStart={(e) => handlePointDrag(i, e)}
                            />
                          ))}
                        </svg>
                      </div>
                    </div>
                  )}
                </div>

                <div className="p-8 bg-white flex flex-col gap-6">
                  <div className="flex flex-col md:flex-row items-center gap-8">
                    <div className="flex-1 w-full">
                      <label className="text-[10px] font-bold uppercase tracking-widest text-black/40 mb-2 block">
                        {cropMode === 'standard' ? 'Zoom & Rotate' : 'Perspective Guide'}
                      </label>
                      <div className="flex items-center gap-6">
                        {cropMode === 'standard' && (
                          <div className="flex-1 flex items-center gap-4">
                            <span className="text-[10px] font-bold text-black/20">ZOOM</span>
                            <input
                              type="range"
                              value={zoom}
                              min={1}
                              max={3}
                              step={0.1}
                              onChange={(e) => setZoom(Number(e.target.value))}
                              className="flex-1 h-1.5 bg-black/5 rounded-lg appearance-none cursor-pointer accent-black"
                            />
                          </div>
                        )}
                        <div className="flex items-center gap-2">
                          <button 
                            onClick={() => setRotation(r => (r + 90) % 360)}
                            className="p-3 rounded-xl bg-black/5 hover:bg-black/10 transition-all flex items-center gap-2 text-xs font-bold"
                          >
                            <RotateCw className="w-4 h-4" />
                            ROTATE
                          </button>
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={saveCrop}
                      className="w-full md:w-auto px-12 py-4 bg-[#1a1a1a] text-white rounded-2xl font-bold uppercase tracking-widest text-xs hover:bg-black/80 transition-all active:scale-95 shadow-xl shadow-black/10"
                    >
                      Apply Changes
                    </button>
                  </div>
                  
                  {cropMode === 'perspective' && (
                    <div className="flex items-center gap-2 text-[10px] font-bold text-emerald-600 uppercase tracking-widest bg-emerald-50 p-3 rounded-xl">
                      <ScanLine className="w-4 h-4" />
                      Drag the corners to align with the edges of your ID card
                    </div>
                  )}
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        <canvas ref={canvasRef} className="hidden" />

        {/* Camera Modal */}
        <AnimatePresence>
          {isCameraOpen && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/95 backdrop-blur-md"
            >
              <motion.div
                initial={{ scale: 0.9, y: 20 }}
                animate={{ scale: 1, y: 0 }}
                className="bg-white w-full max-w-2xl rounded-[2.5rem] overflow-hidden flex flex-col relative"
              >
                <div className="p-6 border-b border-black/5 flex items-center justify-between">
                  <div>
                    <h3 className="text-lg font-bold">Scan {cameraSide === 'front' ? 'Front' : 'Back'} Side</h3>
                    <p className="text-xs text-black/40 font-medium">Position your ID card within the frame</p>
                  </div>
                  <button onClick={stopCamera} className="p-2 rounded-full hover:bg-black/5 transition-colors">
                    <X className="w-6 h-6" />
                  </button>
                </div>

                <div className="relative flex-1 bg-black aspect-[4/3] overflow-hidden">
                  <video 
                    ref={videoRef} 
                    autoPlay 
                    playsInline 
                    className="w-full h-full object-cover"
                  />
                  {/* Overlay Guide */}
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none p-8">
                    <div className={`border-2 border-emerald-500/50 rounded-2xl relative shadow-[0_0_0_100vmax_rgba(0,0,0,0.5)] ${cardOrientation === 'landscape' ? 'w-full aspect-[1.586/1]' : 'h-full aspect-[1/1.586]'}`}>
                      <div className="absolute -top-1 -left-1 w-6 h-6 border-t-4 border-l-4 border-emerald-500 rounded-tl-lg"></div>
                      <div className="absolute -top-1 -right-1 w-6 h-6 border-t-4 border-r-4 border-emerald-500 rounded-tr-lg"></div>
                      <div className="absolute -bottom-1 -left-1 w-6 h-6 border-b-4 border-l-4 border-emerald-500 rounded-bl-lg"></div>
                      <div className="absolute -bottom-1 -right-1 w-6 h-6 border-b-4 border-r-4 border-emerald-500 rounded-br-lg"></div>
                    </div>
                  </div>
                </div>

                <div className="p-8 flex justify-center">
                  <button
                    onClick={capturePhoto}
                    className="w-20 h-20 rounded-full border-4 border-black/10 p-1 hover:scale-105 transition-transform active:scale-95"
                  >
                    <div className="w-full h-full rounded-full bg-[#1a1a1a] flex items-center justify-center">
                      <div className="w-6 h-6 rounded-full border-2 border-white/20"></div>
                    </div>
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        <footer className="text-center text-[#9e9e9e] text-xs pb-12">
          <div className="flex items-center justify-center gap-4 mb-4 opacity-50">
            <div className="h-px w-12 bg-black/10"></div>
            <p className="font-bold uppercase tracking-widest">Local Processing Only</p>
            <div className="h-px w-12 bg-black/10"></div>
          </div>
          <p>© {new Date().getFullYear()} Indian ID Merger Pro • Secure & Private</p>
        </footer>
      </div>
    </div>
  );
}
