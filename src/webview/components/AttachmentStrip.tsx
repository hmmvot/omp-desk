/**
 * The strip under the composer's field: one tile per attachment whose marker is in the draft (docs/designs/2026-10-16-chat-document-attachments.md).
 * An image shows its `data:` thumbnail, a document an icon chosen by its extension and, for neither, no file text. The × calls the Draft's
 * `removeAttachment`, so the attachment goes with its marker as one undo step.
 */
import type { ReactNode } from "react";
import { formatBytes } from "../../shared/file-size";
import type { DraftDocument, DraftImage, ReferenceKind } from "../lib/draft/draft";
import { documentExtension, documentIcon, documentTooltip } from "../lib/document-labels";

export function AttachmentStrip({ images, documents, removeDisabled, onRemove }: {
	images: readonly DraftImage[];
	documents: readonly DraftDocument[];
	/** The × is off: the session cannot take a message, or the hand-off holds the draft. */
	removeDisabled: boolean;
	onRemove(kind: ReferenceKind, number: number): void;
}): ReactNode {
	if (images.length === 0 && documents.length === 0) return null;
	return (
		<ul className="omp-attachments" aria-label="attachments">
			{images.map(image => (
				<li key={image.id} className="omp-attachment" data-image-number={image.number}>
					<span className="omp-attachment-figure">
						<img className="omp-attachment-thumb" alt={`Image #${image.number}`} src={`data:${image.mimeType};base64,${image.data}`} />
						<span className="omp-attachment-number" aria-hidden="true">#{image.number}</span>
					</span>
					<span className="omp-attachment-meta">
						<span className="omp-attachment-name" title={image.name}>
							{image.name}
						</span>
						<span className="omp-attachment-size">{formatBytes(image.bytes)}</span>
					</span>
					<button
						type="button"
						className="omp-attachment-remove"
						disabled={removeDisabled}
						aria-label={`Remove Image #${image.number} (${image.name})`}
						title={`Remove ${image.name}`}
						onClick={() => onRemove("image", image.number)}
					>
						×
					</button>
				</li>
			))}
			{documents.map(document => (
				<li key={`file-${document.number}`} className="omp-attachment" data-file-number={document.number}>
					<span className="omp-attachment-figure omp-attachment-tile" title={documentTooltip(document)}>
						<span aria-hidden="true" className={`codicon codicon-${documentIcon(document.name)}`} />
						<span className="omp-attachment-ext" aria-hidden="true">{documentExtension(document.name).slice(0, 4).toUpperCase()}</span>
						<span className="omp-attachment-number" aria-hidden="true">#{document.number}</span>
					</span>
					<span className="omp-attachment-meta">
						<span className="omp-attachment-name" title={document.name}>
							{document.name}
						</span>
						<span className="omp-attachment-size">{formatBytes(document.source.bytes)}</span>
					</span>
					<button
						type="button"
						className="omp-attachment-remove"
						disabled={removeDisabled}
						aria-label={`Remove File #${document.number} (${document.name})`}
						title={`Remove ${document.name}`}
						onClick={() => onRemove("file", document.number)}
					>
						×
					</button>
				</li>
			))}
		</ul>
	);
}
