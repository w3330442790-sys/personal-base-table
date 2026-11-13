import { memo, useMemo, useRef } from 'react';
import type { ViewDef } from '../../src/core/types';
import { deriveRows } from '../../src/core/features';
import { calculatedSheet } from '../../src/core/formulas';
import { WorkbookGrid } from './WorkbookGrid';

type GridProps = Parameters<typeof WorkbookGrid>[0];
const StableGrid = memo(WorkbookGrid);

/** Selection updates the ribbon without recalculating or rendering the table twice. */
export function ProjectedWorkbookGrid(props: GridProps & { view: ViewDef }) {
  const latest = useRef(props);
  latest.current = props;
  const callbacks = useMemo(() => ({
    transact: (...args: Parameters<GridProps['transact']>) => latest.current.transact(...args),
    onHeaderMenu: (...args: Parameters<GridProps['onHeaderMenu']>) => latest.current.onHeaderMenu(...args),
    onResizeColumns: (...args: Parameters<NonNullable<GridProps['onResizeColumns']>>) => latest.current.onResizeColumns?.(...args),
    onResize: (...args: Parameters<GridProps['onResize']>) => latest.current.onResize(...args),
    onReorderCols: (...args: Parameters<GridProps['onReorderCols']>) => latest.current.onReorderCols(...args),
    onAddField: () => latest.current.onAddField(),
    onDetail: (...args: Parameters<GridProps['onDetail']>) => latest.current.onDetail(...args),
    onSelection: (...args: Parameters<NonNullable<GridProps['onSelection']>>) => latest.current.onSelection?.(...args),
    onMoveToSheet: (...args: Parameters<NonNullable<GridProps['onMoveToSheet']>>) => latest.current.onMoveToSheet?.(...args),
  }), []);
  const rows = useMemo(() => deriveRows(calculatedSheet(props.sheet), props.view), [props.sheet, props.view]);
  return <StableGrid sheet={props.sheet} rows={rows} cols={props.cols} config={props.config} colWidths={props.colWidths}
    frozen={props.frozen} viewId={props.viewId} groupField={props.groupField} canReorder={props.canReorder}
    command={props.command} sequence={props.sequence} onSequenceChange={props.onSequenceChange} {...callbacks} />;
}
