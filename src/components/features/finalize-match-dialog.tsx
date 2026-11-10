"use client";

import { useActionState, useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Flag, X } from "lucide-react";
import { finalizeMatchAction } from "@/actions/racha";
import type { ActionState } from "@/lib/action";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { useToast } from "@/components/ui/toast-provider";

export function FinalizeMatchDialog({
  gameId,
  isDraw,
  teamAName,
  teamBName,
}: {
  gameId: string;
  isDraw: boolean;
  teamAName: string;
  teamBName: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(
    useCallback(async (previous: ActionState, formData: FormData) => {
      const result = await finalizeMatchAction(previous, formData);
      if (result?.ok) setOpen(false);
      return result;
    }, []),
    null,
  );
  const { toast } = useToast();
  const titleId = useId();
  const descriptionId = useId();
  const stayingId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    const timer = window.setTimeout(() => cancelRef.current?.focus(), 20);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
      window.clearTimeout(timer);
    };
  }, [open]);

  useEffect(() => {
    if (!state?.message) return;
    toast({ message: state.message, tone: state.ok ? "success" : "error" });
  }, [state, toast]);

  return (
    <>
      <Button
        type="button"
        variant="success"
        size="lg"
        onClick={() => setOpen(true)}
      >
        <Flag className="h-4 w-4" aria-hidden />
        Finalizar partida
      </Button>

      {open
        ? createPortal(
            <div
              className="fixed inset-0 z-[100] flex items-end justify-center p-3 sm:items-center sm:p-4"
              role="presentation"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) setOpen(false);
              }}
            >
              <div
                className="absolute inset-0 bg-black/65 backdrop-blur-sm"
                aria-hidden
                onClick={() => setOpen(false)}
              />
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                aria-describedby={descriptionId}
                className="relative w-full max-w-sm overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_24px_60px_-24px_rgba(0,0,0,0.45)]"
              >
                <div className="flex items-start gap-3 p-4 pb-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-success-soft text-success">
                    <Flag className="h-5 w-5" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1 pt-0.5">
                    <h2
                      id={titleId}
                      className="font-display text-lg font-semibold uppercase tracking-wide text-ink"
                    >
                      Finalizar partida
                    </h2>
                    <p id={descriptionId} className="mt-1 text-sm leading-relaxed text-muted">
                      {isDraw
                        ? "A partida está empatada. Escolha quem permanece para definir a rotação."
                        : "Finalizar a partida e rodar a fila automaticamente?"}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    aria-label="Fechar"
                    className="rounded-lg p-1 text-muted transition hover:bg-ink/5 hover:text-ink"
                  >
                    <X className="h-4 w-4" aria-hidden />
                  </button>
                </div>

                <form action={formAction} className="border-t border-line/70 bg-surface-2/30 p-3">
                  <input type="hidden" name="gameId" value={gameId} />

                  {isDraw ? (
                    <div>
                      <Label htmlFor={stayingId} required>
                        Empate! Quem permanece?
                      </Label>
                      <Select id={stayingId} name="stayingSide" defaultValue="" required>
                        <option value="" disabled>
                          Selecione quem permanece
                        </option>
                        <option value="A">{teamAName}</option>
                        <option value="B">{teamBName}</option>
                      </Select>
                      <p className="mt-1 text-[11px] text-muted">
                        O resultado continua sendo empate no ranking. A escolha só define a rotação.
                      </p>
                    </div>
                  ) : null}

                  {state && !state.ok && state.message ? (
                    <Alert tone="danger" className="mt-3">
                      {state.message}
                    </Alert>
                  ) : null}

                  <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                    <Button
                      ref={cancelRef}
                      type="button"
                      variant="ghost"
                      size="md"
                      onClick={() => setOpen(false)}
                    >
                      Cancelar
                    </Button>
                    <SubmitButton
                      label="Confirmar finalização"
                      pendingLabel="Finalizando..."
                      variant="success"
                      size="md"
                    />
                  </div>
                </form>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
