"use client";

import { LoaderCircle, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "./Button";
import { Modal } from "./Modal";
import styles from "./FileDeleteButton.module.css";

type Props = {
  path: string;
  folder?: boolean;
  disabled?: boolean;
  onDelete: () => void | Promise<void>;
};

export function FileDeleteButton({ path, folder = false, disabled = false, onDelete }: Props) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const close = () => { if (!submitting.current) setOpen(false); };
  const confirm = async () => {
    if (submitting.current || disabled) return;
    submitting.current = true;
    setPending(true);
    try {
      await onDelete();
      setOpen(false);
    } catch {
      // The connected view reports the error; leave the dialog available to retry.
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };

  return <>
    <Button
      className={styles.trigger}
      compact
      variant="ghost"
      icon={<Trash2 size={15} />}
      aria-label={`删除${folder ? "文件夹" : "文件"} ${path}`}
      title={`删除${folder ? "文件夹" : "文件"}`}
      disabled={disabled || pending}
      onClick={(event) => { event.stopPropagation(); setOpen(true); }}
    >删除</Button>
    {open ? <Modal
      title={folder ? "确认删除文件夹？" : "确认删除文件？"}
      size="compact"
      backdropClassName={styles.backdrop}
      panelClassName={styles.confirmPanel}
      bodyClassName={styles.confirmBody}
      hideCloseButton
      onClose={close}
    >
      <div className={styles.actions}>
        <Button disabled={pending} onClick={close}>取消</Button>
        <Button variant="danger" disabled={pending || disabled} icon={pending ? <LoaderCircle className={styles.spin} size={16} /> : undefined} onClick={() => void confirm()}>{pending ? "正在删除…" : "确认"}</Button>
      </div>
    </Modal> : null}
  </>;
}
