/**
 * Branded identifiers.
 *
 * Episteme stores human understanding, so an id that can be silently swapped for
 * another kind of id is a correctness risk rather than a style question. Every id
 * is a string at runtime and a distinct type at compile time.
 */

declare const brand: unique symbol

export type Brand<T, B extends string> = T & { readonly [brand]: B }

export type ActorId = Brand<string, 'ActorId'>
export type NodeId = Brand<string, 'NodeId'>
export type EdgeId = Brand<string, 'EdgeId'>
export type EventId = Brand<string, 'EventId'>
export type BranchId = Brand<string, 'BranchId'>
export type TagId = Brand<string, 'TagId'>
export type NodeTypeId = Brand<string, 'NodeTypeId'>
export type EdgeTypeId = Brand<string, 'EdgeTypeId'>
export type DimensionId = Brand<string, 'DimensionId'>

/**
 * Casts a plain string into a branded id.
 *
 * This is the single legitimate entry point for turning external input into an id.
 * Callers should use it at the boundary; internal code passes ids around uncast.
 */
export function asId<T extends Brand<string, string>>(value: string): T {
  return value as T
}

export type IdOf<TKind extends string> = Brand<string, `${TKind}Id`>
