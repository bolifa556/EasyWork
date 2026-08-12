"use client";

import { Maximize2, Minus, Plus, RotateCcw } from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import type { ViewerProps } from "@/app/core/registry/viewers";
import { Button } from "../../ui/Button";
import { usePreviewObjectUrl } from "./usePreview";
import { ViewerLoading, ViewerToolbar } from "./ViewerChrome";
import styles from "./Viewer.module.css";

export default function ImageViewer({ descriptor, previewId }: ViewerProps) {
  const { value, error, loading } = usePreviewObjectUrl(previewId, descriptor);
  const [zoom, setZoom] = useState(1);
  return <div className={styles.viewer}>
    <ViewerToolbar descriptor={descriptor}>
      <Button compact iconOnly variant="ghost" aria-label="缩小" icon={<Minus size={15} />} disabled={zoom <= .25} onClick={() => setZoom((value) => Math.max(.25, value - .25))} />
      <span className={styles.zoom}>{Math.round(zoom * 100)}%</span>
      <Button compact iconOnly variant="ghost" aria-label="放大" icon={<Plus size={15} />} disabled={zoom >= 4} onClick={() => setZoom((value) => Math.min(4, value + .25))} />
      <Button compact iconOnly variant="ghost" aria-label="适合窗口" icon={zoom === 1 ? <Maximize2 size={15} /> : <RotateCcw size={15} />} onClick={() => setZoom(1)} />
    </ViewerToolbar>
    {loading ? <ViewerLoading label="正在读取图片" /> : error ? <div className={styles.empty}>{error}</div> : <div className={styles.imageWrap}>{value ? <Image className={styles.image} style={{ transform: `scale(${zoom})` }} src={value} alt={descriptor.name} width={1600} height={1200} unoptimized /> : null}</div>}
  </div>;
}
