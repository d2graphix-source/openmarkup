// Loaded on demand by the review widget to draw the page into a picture (no browser permission prompt needed).
import { domToCanvas } from 'modern-screenshot';
(window as unknown as { __OPENMARKUP_SNAP__: typeof domToCanvas }).__OPENMARKUP_SNAP__ = domToCanvas;
