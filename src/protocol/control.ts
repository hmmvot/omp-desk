/**
 * A provider-qualified model reference as OMP reports it. Not carried by the host-control
 * channel: it is the display shape the host controls panel receives from the rpc-ui session's
 * model list.
 */
export interface ControlModelRef {
	readonly provider: string;
	readonly id: string;
	readonly name?: string;
}
